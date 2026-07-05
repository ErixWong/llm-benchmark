# Scripts

`scripts/` 目录存放仓库维护用的辅助脚本，不参与 `src/` 主程序运行，也不会被 benchmark CLI 自动调用。

## 当前脚本

- `count-tokens.js`
  - 递归扫描 `data/samples/` 下的可用样本
  - 统计每个样本的字符数和 token 数
  - 输出汇总和可组合上下文大小

- `adjust-tokens.js`
  - 检查样本是否落在目标 token 区间
  - 提供补充或裁剪建议
  - 在 `--apply` 时直接修改样本文件

## 使用方式

```bash
node scripts/count-tokens.js
node scripts/adjust-tokens.js
node scripts/adjust-tokens.js --apply
```

## 说明

- 这些脚本的目标是帮助维护 `data/samples/` 的质量
- 它们依赖当前样本目录结构和文件命名规则
- 修改脚本时，应保证与 `src/index.js` 的样本筛选逻辑保持一致
