import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // 渲染器注册表 / tRPC provider / shadcn 库存组件:导出的不是组件而是渲染函数映射、
    // 客户端实例或 cva 变体,react-refresh 的 "only-export-components" 在此属误报
    files: [
      'src/components/renderer/**/*.{ts,tsx}',
      'src/components/ui/**/*.{ts,tsx}',
      'src/providers/**/*.{ts,tsx}',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
