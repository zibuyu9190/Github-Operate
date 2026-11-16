#Requires -Version 7.0
<#
.SYNOPSIS
创建桌面快捷方式，按需启动 Git 图解实验室本地服务。
.DESCRIPTION
Shortcut 创建桌面入口；Start 等待本机后台服务就绪后打开浏览器，重复启动复用原进程。
Serve 仅提供 webui 中的明确静态资源，不执行 Git，也不暴露项目其他文件。
Stop 只停止经过身份核对的本项目进程，不安装登录启动任务。
#>
[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Status', 'Shortcut', 'Serve')]
    [string]$Action = 'Start',
    [ValidateRange(1024, 65535)]
    [int]$Port = 17898,
    [switch]$NoBrowser,
    [switch]$ShortcutLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:RepositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$script:WebRoot = Join-Path $script:RepositoryRoot 'webui'
$script:ServerScript = [IO.Path]::GetFullPath($PSCommandPath)
$script:PowerShellPath = Join-Path $PSHOME 'pwsh.exe'
$script:Url = "http://127.0.0.1:$Port/"
$script:LogPath = Join-Path $script:RepositoryRoot 'target/webui-service/service.log'
$script:Utf8 = [Text.UTF8Encoding]::new($false)
$identityBytes = $script:Utf8.GetBytes($script:RepositoryRoot.ToLowerInvariant())
$hasher = [Security.Cryptography.SHA256]::Create()
try { $script:Instance = [BitConverter]::ToString($hasher.ComputeHash($identityBytes)).Replace('-', '').Substring(0, 16) }
finally { $hasher.Dispose() }
$script:ServerArguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action Serve -Port {1}' -f $script:ServerScript, $Port

function Write-ServiceLog {
    param([string]$Message)
    [IO.Directory]::CreateDirectory((Split-Path -Parent $script:LogPath)) | Out-Null
    [IO.File]::AppendAllText($script:LogPath, ('{0:yyyy-MM-dd HH:mm:ss} PID={1} {2}{3}' -f (Get-Date), $PID, $Message, [Environment]::NewLine), $script:Utf8)
}

function Get-ServiceHealth {
    # 明确绕过代理，健康检查始终直连本机，且不把同端口其他服务误认成本项目。
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMilliseconds(800)
    try {
        $json = $client.GetStringAsync($script:Url + '__health').GetAwaiter().GetResult()
        $health = $json | ConvertFrom-Json
        if ($health.app -eq 'git-playground' -and $health.instance -eq $script:Instance -and $health.port -eq $Port) {
            return $health
        }
    }
    catch { return $null }
    finally { $client.Dispose() }
    return $null
}

function Test-ServicePort {
    $connection = [Net.Sockets.TcpClient]::new()
    try { return $connection.ConnectAsync('127.0.0.1', $Port).Wait(400) }
    catch { return $false }
    finally { $connection.Dispose() }
}

function Start-BackgroundService {
    if ($null -eq (Get-ServiceHealth)) {
        if (Test-ServicePort) { throw "端口 $Port 已被其他服务占用，未停止或替换该服务。" }
        $serverProcess = Start-Process -FilePath $script:PowerShellPath -ArgumentList $script:ServerArguments -WorkingDirectory $script:RepositoryRoot -WindowStyle Hidden -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            if ($null -ne (Get-ServiceHealth)) { break }
            if ($serverProcess.HasExited) { throw "后台服务提前退出，请查看 $script:LogPath。" }
            Start-Sleep -Milliseconds 150
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($null -eq (Get-ServiceHealth)) { throw "服务未能就绪，请查看 $script:LogPath。" }
    }
    Write-Host "Git 图解实验室已就绪：$script:Url"
    if (-not $NoBrowser) { Start-Process -FilePath $script:Url }
}

function Stop-BackgroundService {
    $health = Get-ServiceHealth
    if ($null -eq $health) {
        if (Test-ServicePort) { throw "端口 $Port 上运行的服务无法确认为本项目，未终止任何进程。" }
        Write-Host 'Git 图解实验室当前未运行。'
        return
    }
    # 同时校验健康标识、可执行文件和完整服务参数，防止 PID 误用时结束其他进程。
    $serverProcessId = [int]$health.pid
    $details = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId"
    if ($null -eq $details -or $details.ExecutablePath -ine $script:PowerShellPath -or -not $details.CommandLine.EndsWith($script:ServerArguments, [StringComparison]::OrdinalIgnoreCase)) {
        throw '服务进程的启动参数与本项目不符，未终止该进程。'
    }
    $process = Get-Process -Id $serverProcessId
    Stop-Process -InputObject $process
    if (-not $process.WaitForExit(5000) -or (Test-ServicePort)) { throw '服务尚未完全停止，请检查端口和日志。' }
    Write-Host 'Git 图解实验室后台服务已停止。'
}

function New-DesktopShortcut {
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Git 图解实验室.lnk'
    $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action Start -Port {1} -ShortcutLaunch' -f $script:ServerScript, $Port
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $null
    try {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        if ((Test-Path -LiteralPath $shortcutPath) -and ($shortcut.TargetPath -ine $script:PowerShellPath -or $shortcut.Arguments -ine $arguments)) {
            throw '桌面存在同名但指向其他位置的快捷方式，未覆盖它。'
        }
        $shortcut.TargetPath = $script:PowerShellPath
        $shortcut.Arguments = $arguments
        $shortcut.WorkingDirectory = $script:RepositoryRoot
        $shortcut.Description = '双击启动并打开 Git 图解实验室'
        $shortcut.IconLocation = (Join-Path ([Environment]::GetFolderPath('System')) 'shell32.dll') + ',14'
        $shortcut.WindowStyle = 7
        $shortcut.Save()
        Write-Host "已创建桌面快捷方式：$shortcutPath"
    }
    finally {
        if ($null -ne $shortcut) { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null }
        [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
    }
}

function Write-HttpResponse {
    param(
        [IO.Stream]$Stream,
        [int]$Status,
        [string]$ContentType,
        [byte[]]$Body,
        [bool]$HeadOnly = $false
    )
    $reason = @{ 200 = 'OK'; 400 = 'Bad Request'; 404 = 'Not Found'; 405 = 'Method Not Allowed'; 431 = 'Request Header Fields Too Large'; 500 = 'Internal Server Error' }[$Status]
    $header = "HTTP/1.1 $Status $reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n"
    if ($Status -eq 405) { $header += "Allow: GET, HEAD`r`n" }
    $bytes = [Text.Encoding]::ASCII.GetBytes($header + "`r`n")
    $Stream.Write($bytes, 0, $bytes.Length)
    if (-not $HeadOnly -and $Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

function Invoke-StaticRequest {
    param([Net.Sockets.TcpClient]$Connection)
    $Connection.ReceiveTimeout = 1500
    $Connection.SendTimeout = 1500
    $stream = $Connection.GetStream()
    $buffer = [byte[]]::new(8192)
    $used = 0
    $request = ''
    while ($used -lt $buffer.Length) {
        $count = $stream.Read($buffer, $used, $buffer.Length - $used)
        if ($count -eq 0) { return }
        $used += $count
        $request = [Text.Encoding]::ASCII.GetString($buffer, 0, $used)
        if ($request.Contains("`r`n`r`n")) { break }
    }
    if (-not $request.Contains("`r`n`r`n")) {
        Write-HttpResponse $stream 431 'text/plain; charset=utf-8' ($script:Utf8.GetBytes('Request headers too large.'))
        return
    }
    $parts = $request.Split("`r`n")[0].Split(' ', [StringSplitOptions]::RemoveEmptyEntries)
    if ($parts.Count -ne 3 -or $parts[2] -notmatch '^HTTP/1\.[01]$') {
        Write-HttpResponse $stream 400 'text/plain; charset=utf-8' ($script:Utf8.GetBytes('Bad request.'))
        return
    }
    $headOnly = $parts[0] -eq 'HEAD'
    if ($parts[0] -notin @('GET', 'HEAD')) {
        Write-HttpResponse $stream 405 'text/plain; charset=utf-8' ($script:Utf8.GetBytes('Only GET and HEAD are supported.'))
        return
    }
    $requestPath = [Uri]::UnescapeDataString($parts[1].Split('?')[0])
    if ($requestPath -ceq '/__health') {
        $health = @{ app = 'git-playground'; instance = $script:Instance; port = $Port; pid = $PID } | ConvertTo-Json -Compress
        Write-HttpResponse $stream 200 'application/json; charset=utf-8' ($script:Utf8.GetBytes($health)) $headOnly
        return
    }
    # 路由只映射明确的网页资源，不把 URL 拼成任意文件系统路径，也不提供目录列表。
    $assets = @{
        '/' = @('index.html', 'text/html; charset=utf-8')
        '/index.html' = @('index.html', 'text/html; charset=utf-8')
        '/styles.css' = @('styles.css', 'text/css; charset=utf-8')
        '/commands.js' = @('commands.js', 'text/javascript; charset=utf-8')
        '/command-assist.js' = @('command-assist.js', 'text/javascript; charset=utf-8')
        '/command-assist.css' = @('command-assist.css', 'text/css; charset=utf-8')
        '/simulator.js' = @('simulator.js', 'text/javascript; charset=utf-8')
        '/lessons.js' = @('lessons.js', 'text/javascript; charset=utf-8')
        '/lessons.css' = @('lessons.css', 'text/css; charset=utf-8')
        '/graph.js' = @('graph.js', 'text/javascript; charset=utf-8')
        '/graph-viewer.js' = @('graph-viewer.js', 'text/javascript; charset=utf-8')
        '/graph-viewer.css' = @('graph-viewer.css', 'text/css; charset=utf-8')
        '/terminal-history.js' = @('terminal-history.js', 'text/javascript; charset=utf-8')
        '/terminal-history.css' = @('terminal-history.css', 'text/css; charset=utf-8')
        '/app.js' = @('app.js', 'text/javascript; charset=utf-8')
    }
    if (-not $assets.ContainsKey($requestPath)) {
        Write-HttpResponse $stream 404 'text/plain; charset=utf-8' ($script:Utf8.GetBytes('Not found.')) $headOnly
        return
    }
    $asset = $assets[$requestPath]
    $body = [IO.File]::ReadAllBytes((Join-Path $script:WebRoot $asset[0]))
    Write-HttpResponse $stream 200 $asset[1] $body $headOnly
}

function Start-StaticServer {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    try {
        $listener.Start()
        Write-ServiceLog "START $script:Url root=$script:WebRoot"
        while ($true) {
            $connection = $listener.AcceptTcpClient()
            try { Invoke-StaticRequest $connection }
            catch {
                # 预连接取消、超时和浏览器断开属于单次请求失败，不结束后台服务。
                if ($_.Exception -isnot [IO.IOException]) { Write-ServiceLog ('REQUEST ERROR ' + $_.Exception.Message) }
            }
            finally { $connection.Dispose() }
        }
    }
    catch { Write-ServiceLog ('SERVER ERROR ' + $_.Exception.Message); throw }
    finally { $listener.Stop() }
}

try {
    if ($Action -eq 'Serve') { Start-StaticServer; exit 0 }
    # 串行化多次双击和停止操作，避免为同一页面重复创建后台进程。
    $mutex = [Threading.Mutex]::new($false, 'Local\GitPlaygroundLauncher-' + $script:Instance)
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(15)) }
        catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw '另一个启动/停止操作仍在进行，请稍后重试。' }
        switch ($Action) {
            'Start' { Start-BackgroundService }
            'Stop' { Stop-BackgroundService }
            'Shortcut' { New-DesktopShortcut }
            'Status' {
                $health = Get-ServiceHealth
                [pscustomobject]@{ Url = $script:Url; Ready = ($null -ne $health); ProcessId = $(if ($null -eq $health) { $null } else { $health.pid }) }
            }
        }
    }
    finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
catch {
    $failure = $_.Exception.Message
    if ($ShortcutLaunch) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show($failure, 'Git 图解实验室启动失败', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    }
    Write-Error -Message $failure -ErrorAction Continue
    exit 1
}
