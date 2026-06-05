# fuzzy-at

`extensions/fuzzy-at.ts` 用 Snacks.nvim 风格的文件枚举 + 内部 fuzzy matcher，替换 pi 内置 `@` 文件补全里的查询逻辑。

目标：输入类似下面的 query 时，也能找到完整路径中的子序列匹配：

```text
@myfbar
```

匹配：

```text
my/path/foobar.md
```

也支持 PRD 里的例子：

```text
@mpafbar -> my/path/foobar.md
```

## Background

pi 内置 `@` 补全主要由 `CombinedAutocompleteProvider` 实现：

```text
@earendil-works/pi-tui/dist/autocomplete.js
```

内置流程大致是：

1. editor 在 token 边界输入 `@` 时触发 autocomplete；
2. `CombinedAutocompleteProvider.extractAtPrefix()` 识别 `@...`；
3. `getFuzzyFileSuggestions()` 调用 `fd` 搜文件；
4. 内置 `scoreEntry()` 排序；
5. `applyCompletion()` 把候选插入为 `@path`。

问题是内置实现会把 query 传给外部命令，例如接近：

```sh
fd myfbar
```

因此 `my/path/foobar.md` 这种跨路径段的子序列 query 不一定能被外部命令枚举出来。

Snacks.nvim 的 `Snacks.picker.files()` 默认不是这样做的。它更接近：

```text
fd / rg / find 枚举文件
        ↓
Lua 内部 matcher 对完整文件列表做 fuzzy 匹配
        ↓
fzf 风格 scoring 排序
```

参考源码：

```text
~/src/snacks.nvim@folke/lua/snacks/picker/source/files.lua
~/src/snacks.nvim@folke/lua/snacks/picker/core/matcher.lua
~/src/snacks.nvim@folke/lua/snacks/picker/core/score.lua
```

PRD：

```text
prd.md
```

## Current implementation

扩展文件：

```text
extensions/fuzzy-at.ts
```

测试文件：

```text
tests/fuzzy-at.test.ts
```

注册方式：

```ts
pi.on('session_start', (_event, ctx) => {
  ctx.ui.addAutocompleteProvider((current) =>
    createFuzzyAtProvider(current, getPaths, ctx.cwd, (text) => ctx.ui.theme.fg('warning', text)),
  );
});
```

也就是说它通过 `ctx.ui.addAutocompleteProvider()` 包在内置 provider 外面：

```text
fuzzy-at provider
  -> pi built-in CombinedAutocompleteProvider
```

自定义 provider 会处理 `@query`，并且会把刚输入 `@` 时内置 provider 返回的空 query 候选重排成单列 full path 展示。以下情况仍委托给内置 provider：

- 不是 `@` token；
- 文件枚举失败且内置 provider 仍有结果；
- 自定义 fuzzy 没有匹配结果且内置 provider 仍有结果。

## Finder flow

文件枚举顺序参考 Snacks.nvim：

1. `fd`
2. `fdfind`
3. `rg --files`
4. `find`

实现函数：

```ts
buildFinderCommands();
enumerateCandidatePaths();
```

当前参数：

```text
fd --type f --type l --color never -E .git
fdfind --type f --type l --color never -E .git
rg --files --no-messages --color never -g '!.git'
find . -type f -not -path '*/.git/*'
```

注意：这比 pi 内置 `@` 的 `fd` 参数更接近 Snacks 默认 files source：主要枚举文件和 symlink，不枚举目录。内置 pi 会补全目录；本扩展当前重点是文件 fuzzy 查找。

文件列表会按 `cwd` 缓存：

```ts
const CACHE_TTL_MS = 15_000;
```

这样不会每次按键都重新运行 finder。

## Matching model

核心 matcher 是子序列匹配：

```text
候选路径: my/path/foobar.md
query:    mpafbar
匹配:     m  p a    f   b a r
```

实现函数：

```ts
fuzzyMatchPath(path, query);
fuzzyFindMatch(searchText, displayText, chars, init);
fuzzyScorePath(path, query);
filterFuzzyPaths(paths, query);
```

行为要点：

- query 会按空白拆分为多个 token；
- 每个 token 都必须匹配；
- lowercase query 走 ignorecase；
- 包含大写时走 smartcase 风格区分大小写；
- 在完整路径上匹配，不只匹配 basename。

## Scoring model

评分参考 Snacks 的 `score.lua`，也就是 fzf 风格 scoring。

已实现的核心权重：

- `SCORE_MATCH = 16`
- gap start penalty
- gap extension penalty
- boundary bonus
- delimiter boundary bonus
- camelCase / number transition bonus
- consecutive bonus
- first char multiplier
- filename bonus（当匹配起点后面没有路径分隔符时加分）

排序方向参考 Snacks 默认 files picker：

```text
score:desc -> #text:asc -> idx:asc
```

对应到本扩展：分数越高越靠前；同分时短路径优先；仍同分时按稳定 idx。

```ts
scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.index - b.index);
```

Snacks 的 `idx` 来自 finder 产出顺序。本扩展为了让结果跨 finder / 跨运行更稳定，会先把枚举出的候选路径按字典序稳定化，然后再把该顺序作为 `idx`。

## Presentation / highlighting

匹配过程中会记录命中字符的位置：

```ts
interface FuzzyMatch {
  score: number;
  positions: number[];
}
```

候选展示现在更接近 Snacks.nvim 的 file formatter：主列直接展示完整相对路径，而不是 basename + description 两列。刚输入 `@` 时，内置 provider 返回的空 query 结果也会被转换成同样的单列路径：

```text
→ editor/editor_node.h
  editor/editor_node.cpp
  editor/translations/editor/th.po
```

命中字符会在路径字符串内做 ANSI 高亮：

```ts
label: highlightPositions(match.path, match.positions, 0, highlightStyle);
```

当前高亮颜色使用 pi 当前主题的 `warning`：

```ts
(text) => ctx.ui.theme.fg('warning', text);
```

这样能跟用户主题保持一致。

实现上这是利用 pi-tui 的 `SelectList` 会保留 ANSI escape code 的特性。`visibleWidth()` 和 `truncateToWidth()` 支持 ANSI，因此显示宽度不会被颜色码破坏。

长路径展示也参考 Snacks.nvim 的 `truncpath()`：当 autocomplete 行宽不足时，通过 monkey patch 只对本扩展产生的 `@` 文件候选使用中间折叠，例如：

```text
a/b/c/d/e.md -> a/…/d/e.md
```

折叠后仍会把原始 match positions 映射到可见路径，尽量保留可见命中字符的高亮。

选中行会绕开 pi-tui 默认的整行 `selectedText()` 包裹，只给 `→ ` 前缀使用 selected prefix 样式，避免 selected ANSI 与 match ANSI 互相 reset / 覆盖。

### Limitation

pi 的 autocomplete API 当前只有：

```ts
AutocompleteItem = {
  value: string;
  label: string;
  description?: string;
}
```

没有正式的 `matchedRanges` 或 autocomplete-specific custom item renderer。因此当前实现一方面把 ANSI 高亮嵌入 `label`，另一方面通过 patch `SelectList.renderItem()` 只对 fuzzy-at 候选做长路径折叠和选中行渲染。

如果未来要做和 Snacks 完全一致的高亮/主题行为，最好在 pi-tui 层扩展：

- `AutocompleteItem.matchedRanges`
- 或 `SelectList` custom renderer
- 或 autocomplete-specific theme slot

## Completion behavior

候选项的 `value` 仍是可插入路径：

```ts
value: quoteCompletionPath(match.path, quoted);
```

路径含空格或用户正在使用 quoted token 时，会生成：

```text
@"my path/file.md"
```

否则生成：

```text
@my/path/file.md
```

插入行为仍委托给内置 provider：

```ts
applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
  return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
}
```

因此文件补全后会自动追加空格等行为仍保持 pi 内置逻辑。

## Tests

测试覆盖：

- `@` token 提取；
- quoted `@"...` token 提取；
- `my/path/foobar.md` 对 `mpafbar` / `myfbar` 的子序列匹配；
- fuzzy 结果包含 match positions；
- Snacks 默认排序字段：`score:desc -> #text:asc -> idx:asc`；
- warning 高亮 span 生成；
- full path 单列候选展示；
- 长路径中间折叠和 position remap；
- 空 `@` 时内置候选转换为单列 full path；
- 选中行不覆盖 match highlight；
- finder path normalize / dedupe / stable sort；
- quoted completion value；
- finder fallback 顺序。

运行：

```bash
bun test tests/fuzzy-at.test.ts
```

项目级验证：

```bash
bun run format:check
bun test
```

截至最近验证：

```text
bun run format:check ✅
bun test ✅ 46 pass
bun tsc --noEmit --ignoreConfig ... extensions/fuzzy-at.ts ✅
```

`bun run typecheck` 当前会因为既有的 `extensions/terminal-signals.ts` 中 `SessionSwitchEvent/session_switch` 类型问题失败；和 `fuzzy-at.ts` 无关。

## Usage

修改后在 pi 中执行：

```text
/reload
```

然后输入：

```text
@myfbar
```

应该能看到类似：

```text
my/path/foobar.md
```

并且命中的字符用当前 theme 的 `warning` 色高亮。

## Future work

可选优化方向：

1. 枚举目录候选
   - 自定义 fuzzy 枚举当前更贴近 Snacks files source，只枚举 file / symlink。
   - 空 `@` 或 fallback 到内置 provider 时仍可能显示目录。
   - 如果想让非空 query 的 fuzzy 也补全目录，可以加入 directory enumeration。
2. 更长缓存或文件 watcher invalidation
   - 当前 TTL 是 15 秒。
   - 大仓库里可以考虑更长 TTL 或 watch invalidation。
3. top-k / incremental matching
   - Snacks matcher 会优先处理已有 topk 和 previous matches。
   - 当前实现每次对缓存列表全量 scan。
4. 正式 autocomplete 高亮 API
   - 避免 ANSI piggyback。
   - 让主题/选中行/高亮层级更可控。
