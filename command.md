# Git 图解实验室双人协作命令

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
