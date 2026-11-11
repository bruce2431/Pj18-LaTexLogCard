# Pj18 LaTeX 编译日志卡片

Pj18 · LaTeX 书稿工作区的「编译日志」预览卡。跟随打开的 `main.tex` 显示对应书稿的编译账本与报错，
点击报错行可跳回源码位置。

## 结构

- `card.json` — 卡片注册（标题、入口、排序）
- `index.html` + `css/log.css` + `js/log.js` — 卡片本体

## 部署

把本目录整体放到 Pj18 项目的 `.claude/preview/log/`，重启预览或切卡即可生效；
预览宿主按 `card.json` 注册，卡片列表中的「编译日志」即为本卡。

## 关联

- PDF 卡仓库：https://github.com/bruce2431/Pj18-LaTexEditorCard
