# Git 图解实验室双人协作命令

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
| 29 | 协作者本地 | `git merge origin/feature-cart` |
| 30 | 协作者本地 | `git push` |
| 31 | 我的本地 | `git fetch origin` |
| 32 | 我的本地 | `git merge origin/dev` |

复练时，先用对应身份准备各次提交涉及的文件改动，再执行 `git add`。本轮练习结束后，双方的本地 `dev` 和共享远程 `dev` 都指向包含订单和购物车改动的 `C9`。

## 方案二 · 一人合入两个功能分支

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
