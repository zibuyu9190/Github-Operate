# Git 图解实验室协作练习命令

## 方案一 · 两人各自合入自己的功能分支

这份清单按“基础提交”场景中的实际执行顺序整理。原日志有 33 条记录，其中 32 条成功、1 条失败。修正后共 32 条命令，由“我的本地”执行 17 条，“协作者本地”执行 15 条。

原第 10 条 `git push` 失败，因为 `feature-order` 尚未设置上游。原第 11 条 `git push -u origin feature-order` 已成功发布分支并设置上游。下表保留这条成功命令，去掉失败的尝试后重新编号。

| 顺序 | 执行者 | 命令 |
| ---: | --- | --- |
| 1 | 我的本地 | `git switch -c dev` |
| 2 | 我的本地 | `git push -u origin dev` |
| 3 | 我的本地 | `git switch -c feature-order` |
| 4 | 我的本地 | `git add aaa.txt` |
| 5 | 我的本地 | `git commit -m "order 订单新增"` |
| 6 | 我的本地 | `git add bbb.txt` |
| 7 | 我的本地 | `git commit -m "order 订单删除"` |
| 8 | 我的本地 | `git add bbb.txt ccc.txt` |
| 9 | 我的本地 | `git commit -m "order 订单合并"` |
| 10 | 我的本地 | `git push -u origin feature-order` |
| 11 | 协作者本地 | `git fetch origin` |
| 12 | 协作者本地 | `git switch dev` |
| 13 | 协作者本地 | `git switch -c feature-cart` |
| 14 | 协作者本地 | `git add cart.txt` |
| 15 | 协作者本地 | `git commit -m "cart 购物车生成"` |
| 16 | 协作者本地 | `git add node.txt` |
| 17 | 协作者本地 | `git commit -m "cart 购物车删除"` |
| 18 | 协作者本地 | `git add test.md` |
| 19 | 协作者本地 | `git commit -m "cart 购物车合并"` |
| 20 | 协作者本地 | `git push -u origin feature-cart` |
| 21 | 我的本地 | `git fetch origin` |
| 22 | 我的本地 | `git switch dev` |
| 23 | 我的本地 | `git merge origin/dev` |
| 24 | 我的本地 | `git merge feature-order` |
| 25 | 我的本地 | `git push` |
| 26 | 协作者本地 | `git fetch origin` |
| 27 | 协作者本地 | `git switch dev` |
| 28 | 协作者本地 | `git merge origin/dev` |
| 29 | 协作者本地 | `git merge feature-cart` |
| 30 | 协作者本地 | `git push` |
| 31 | 我的本地 | `git fetch origin` |
| 32 | 我的本地 | `git merge origin/dev` |

复练时，先用对应身份准备各次提交涉及的文件改动，再执行 `git add`。本轮练习结束后，双方的本地 `dev` 和共享远程 `dev` 都指向包含订单和购物车改动的 `C9`。

## 方案二 · 我的本地合入两个功能分支

从“基础提交”的初始状态开始。两人都从 `dev` 创建自己的功能分支。等 `feature-order` 和 `feature-cart` 都推送成功后，由“我的本地”统一合入 `dev` 并推送。每次 `git add` 前，先用对应身份准备表中的文件改动。

| 顺序 | 执行者 | 命令 |
| ---: | --- | --- |
| 1 | 我的本地 | `git switch -c dev` |
| 2 | 我的本地 | `git push -u origin dev` |
| 3 | 我的本地 | `git switch -c feature-order` |
| 4 | 我的本地 | `git add aaa.txt` |
| 5 | 我的本地 | `git commit -m "order 订单生成"` |
| 6 | 我的本地 | `git add bbb.txt` |
| 7 | 我的本地 | `git commit -m "order 订单提交"` |
| 8 | 我的本地 | `git push -u origin feature-order` |
| 9 | 协作者本地 | `git fetch origin` |
| 10 | 协作者本地 | `git switch dev` |
| 11 | 协作者本地 | `git switch -c feature-cart` |
| 12 | 协作者本地 | `git add cart.md` |
| 13 | 协作者本地 | `git commit -m "cart 购物车生成"` |
| 14 | 协作者本地 | `git add one.txt` |
| 15 | 协作者本地 | `git commit -m "cart 购物车合并"` |
| 16 | 协作者本地 | `git push -u origin feature-cart` |
| 17 | 我的本地 | `git fetch origin` |
| 18 | 我的本地 | `git switch dev` |
| 19 | 我的本地 | `git merge origin/dev` |
| 20 | 我的本地 | `git merge origin/feature-order` |
| 21 | 我的本地 | `git merge origin/feature-cart` |
| 22 | 我的本地 | `git push` |

第 17 步获取最新的 `origin/dev` 和两条远程功能分支。第 19 步把共享远程已有的进度合入本地 `dev`。如果两者已经指向同一个提交，会提示 `Already up to date.`。随后按顺序合入订单和购物车。由于第 2 步已设置 `dev` 的上游，第 22 步直接使用 `git push` 即可。

### 协作者同步合并结果（按需）

第 22 步成功后，共享远程 `dev` 已包含两个功能。协作者如果要基于这个版本继续开发，可以执行以下三步。如果刚刚已经 `fetch` 到合并结果，直接从第 24 步开始。

| 顺序 | 执行者 | 命令 |
| ---: | --- | --- |
| 23 | 协作者本地 | `git fetch origin` |
| 24 | 协作者本地 | `git switch dev` |
| 25 | 协作者本地 | `git merge origin/dev` |

协作者完成第 23–25 步后，双方的本地 `dev` 和共享远程 `dev` 都指向 `C7`。

## 方案三 · 协作者合入两个功能分支

从“基础提交”的初始状态开始。两人分别从 `dev` 创建并推送各自的功能分支，由“协作者本地”先合入购物车、再合入订单，最后统一推送 `dev`。每次 `git add` 前，先用对应身份准备相应的文件改动。

| 顺序 | 执行者 | 命令 |
| ---: | --- | --- |
| 1 | 我的本地 | `git switch -c dev` |
| 2 | 我的本地 | `git push -u origin dev` |
| 3 | 我的本地 | `git switch -c feature-order` |
| 4 | 我的本地 | `git add aaa.txt` |
| 5 | 我的本地 | `git commit -m "order 订单新建"` |
| 6 | 我的本地 | `git add bbb.txt` |
| 7 | 我的本地 | `git commit -m "order 订单合并"` |
| 8 | 我的本地 | `git push -u origin feature-order` |
| 9 | 协作者本地 | `git fetch origin` |
| 10 | 协作者本地 | `git switch dev` |
| 11 | 协作者本地 | `git switch -c feature-cart` |
| 12 | 协作者本地 | `git add cart.md` |
| 13 | 协作者本地 | `git commit -m "cart 购物车文档开发"` |
| 14 | 协作者本地 | `git add one.txt` |
| 15 | 协作者本地 | `git commit -m "cart 购物车合并"` |
| 16 | 协作者本地 | `git add nodes.java` |
| 17 | 协作者本地 | `git commit -m "cart 购物车删除"` |
| 18 | 协作者本地 | `git push -u origin feature-cart` |
| 19 | 协作者本地 | `git fetch origin` |
| 20 | 协作者本地 | `git switch dev` |
| 21 | 协作者本地 | `git merge origin/dev` |
| 22 | 协作者本地 | `git merge origin/feature-cart` |
| 23 | 协作者本地 | `git merge origin/feature-order` |
| 24 | 协作者本地 | `git push` |
| 25 | 我的本地 | `git fetch origin` |
| 26 | 我的本地 | `git switch dev` |
| 27 | 我的本地 | `git merge origin/dev` |

第 9 步获取 `origin/dev`，供协作者建立本地 `dev`。第 19–21 步先获取最新远程状态，再切到 `dev` 并合入 `origin/dev`，然后才合入两个功能分支。

第 24 步结束后，共享远程 `dev` 已包含两个功能。第 25–27 步把「我的本地」也同步到合并结果。第 26 步先切到 `dev`，使最后一次合并更新本地 `dev`。按本轮提交顺序，完成后双方的本地 `dev` 和共享远程 `dev` 都指向 `C8`。

## 方案四 · 合并负责人统一合入两个功能分支

从“基础提交”的初始状态开始。“我的本地”开发订单，“协作者本地”开发购物车，两人从同一个 `dev` 基线创建并推送各自的功能分支，随后由“合并负责人”统一合入 `dev`。每次执行 `git add` 前，先用对应身份创建或编辑表中指定的文件。

| 顺序 | 执行者 | 命令 |
| ---: | --- | --- |
| 1 | 我的本地 | `git switch -c dev` |
| 2 | 我的本地 | `git push -u origin dev` |
| 3 | 我的本地 | `git switch -c feature-order` |
| 4 | 我的本地 | `git add aaa.txt` |
| 5 | 我的本地 | `git commit -m "order 订单生成"` |
| 6 | 我的本地 | `git push -u origin feature-order` |
| 7 | 协作者本地 | `git fetch origin` |
| 8 | 协作者本地 | `git switch dev` |
| 9 | 协作者本地 | `git switch -c feature-cart` |
| 10 | 协作者本地 | `git add cart.md` |
| 11 | 协作者本地 | `git commit -m "cart 购物车生成"` |
| 12 | 协作者本地 | `git add one.txt` |
| 13 | 协作者本地 | `git commit -m "cart 购物车删除"` |
| 14 | 协作者本地 | `git push -u origin feature-cart` |
| 15 | 合并负责人 | `git fetch origin` |
| 16 | 合并负责人 | `git switch dev` |
| 17 | 合并负责人 | `git merge origin/dev` |
| 18 | 合并负责人 | `git merge --no-ff origin/feature-order` |
| 19 | 合并负责人 | `git merge --no-ff origin/feature-cart` |
| 20 | 合并负责人 | `git push` |

等两条功能分支都发布后，再切换到“合并负责人”。第 15 步获取 `origin/dev` 和两条功能分支的跟踪引用，第 16–17 步切到本地 `dev` 并同步已有进度。本轮两者都在 `C2`，第 17 步会提示 `Already up to date.`。

第 18 步用 `--no-ff` 合入订单分支，即使可以从 `C2` 快进到 `C3`，也会创建独立的合并提交 `C6`。第 19 步继续沿用 `--no-ff` 保持合入功能分支的统一习惯（此时 `dev` 与购物车分支已分叉，写不写 `--no-ff` 都会创建合并提交 `C7`）。第 20 步将包含两个功能的 `dev` 推送到共享远程。

### 两个开发身份同步合并结果（按需）

| 顺序 | 执行者 | 命令 |
| ---: | --- | --- |
| 21 | 我的本地 | `git fetch origin` |
| 22 | 我的本地 | `git switch dev` |
| 23 | 我的本地 | `git merge origin/dev` |
| 24 | 协作者本地 | `git fetch origin` |
| 25 | 协作者本地 | `git switch dev` |
| 26 | 协作者本地 | `git merge origin/dev` |

第 20 步完成后，合并负责人的本地 `dev` 和共享远程 `dev` 都指向 `C7`。第 23、26 步分别把两位开发者的本地 `dev` 从 `C2` 快进到 `C7`。确认本地 `dev` 已同步后，两位开发者还可按需清理已合入的本地功能分支（“我的本地”执行 `git branch -d feature-order`，“协作者本地”执行 `git branch -d feature-cart`；真实远程仓库可用 `git push origin --delete <分支名>` 清理远程分支）。
