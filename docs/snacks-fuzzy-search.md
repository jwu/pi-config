# Snacks.nvim fuzzy search implementation

这篇文档整理 `snacks.nvim` 中 `Snacks.picker.files()` 的 fuzzy search 实现方式，重点说明为什么输入类似：

```text
mpafbar
```

可以匹配到：

```text
my/path/foobar.md
```

参考源码位于：

```text
~/src/snacks.nvim@folke/lua/snacks/picker/source/files.lua
~/src/snacks.nvim@folke/lua/snacks/picker/source/proc.lua
~/src/snacks.nvim@folke/lua/snacks/picker/core/finder.lua
~/src/snacks.nvim@folke/lua/snacks/picker/core/matcher.lua
~/src/snacks.nvim@folke/lua/snacks/picker/core/score.lua
~/src/snacks.nvim@folke/lua/snacks/picker/config/sources.lua
~/src/snacks.nvim@folke/lua/snacks/picker/config/defaults.lua
```

## High-level conclusion

`Snacks.picker.files()` 默认情况下不是每次用户输入 query 后都直接执行：

```sh
fd mpafbar
```

而是分成两个阶段：

```text
1. fd / rg / find 枚举候选文件
2. Snacks 内部 matcher 对候选文件做 fuzzy 匹配、评分、排序
```

因此外部命令主要负责 **收集候选文件列表**，真正的 fuzzy 子序列匹配和排序发生在 Snacks 的 Lua 代码中。

## Files source configuration

files source 的默认配置在：

```text
lua/snacks/picker/config/sources.lua
```

对应片段：

```lua
M.files = {
  finder = "files",
  format = "file",
  show_empty = true,
  hidden = false,
  ignored = false,
  follow = false,
  supports_live = true,
}
```

关键点：

- `finder = "files"`：使用 files finder；
- `hidden = false`：默认不显示 hidden files；
- `ignored = false`：默认尊重 ignore；
- `follow = false`：默认不跟随 symlink；
- `supports_live = true`：支持 live mode，但默认 picker 不一定启用 live。

matcher 默认配置在：

```text
lua/snacks/picker/config/defaults.lua
```

默认 matcher：

```lua
matcher = {
  fuzzy = true,
  smartcase = true,
  ignorecase = true,
  sort_empty = false,
  filename_bonus = true,
  file_pos = true,
  cwd_bonus = false,
  frecency = false,
  history_bonus = false,
}
```

关键点：

- `fuzzy = true`：启用 fuzzy 子序列匹配；
- `smartcase = true`：query 全小写时 ignorecase，含大写时区分大小写；
- `filename_bonus = true`：匹配文件名部分时加分；
- `sort_empty = false`：空 query 时默认不重新排序；
- `cwd_bonus` / `frecency` 默认关闭，但 smart picker 等 source 可以打开。

## Candidate enumeration

文件枚举逻辑在：

```text
lua/snacks/picker/source/files.lua
```

Snacks 默认按顺序选择可用命令：

1. `fd` / `fdfind`
2. `rg --files`
3. Unix `find`

源码中的 command table：

```lua
local commands = {
  {
    cmd = { "fd", "fdfind" },
    args = { "--type", "f", "--type", "l", "--color", "never", "-E", ".git" },
  },
  {
    cmd = { "rg" },
    args = { "--files", "--no-messages", "--color", "never", "-g", "!.git" },
  },
  {
    cmd = { "find" },
    args = { ".", "-type", "f", "-not", "-path", "*/.git/*" },
    enabled = vim.fn.has("win-32") == 0,
  },
}
```

默认 `fd` 命令大致是：

```sh
fd --type f --type l --color never -E .git
```

如果没有 `fd`，fallback 到：

```sh
rg --files --no-messages --color never -g '!.git'
```

再 fallback 到：

```sh
find . -type f -not -path '*/.git/*'
```

这些命令默认的作用是枚举候选文件，不负责默认 fuzzy 匹配。

## Finder options

`files.lua` 的 `get_cmd(opts, filter)` 会根据 picker options 修改命令参数。

常见选项：

### exclude

`opts.exclude` 会转换成：

- `fd`: `-E <pattern>`
- `rg`: `-g !<pattern>`
- `find`: `-not -path <pattern>`

### ft / extensions

`opts.ft` 会限制扩展名：

- `fd`: `-e <ext>`
- `rg`: `-g '*.<ext>'`
- `find`: `-name '*.<ext>'`

### hidden

- `hidden = true` 且是 `fd` / `rg` 时，加 `--hidden`；
- `hidden = false` 且是 `find` 时，加 `-not -path '*/.*'`。

### ignored

`ignored = true` 且是 `fd` / `rg` 时，加：

```text
--no-ignore
```

### follow

`follow = true` 时加：

```text
-L
```

### live/search pattern

`files` source 支持 live mode。`get_cmd()` 中会解析 `filter.search`，并在 live/search pattern 存在时把 pattern 传给 finder 命令。

这时行为会更接近：

```sh
fd <pattern>
```

但默认 files picker 的核心体验不是 live 外部搜索，而是先枚举，再内部 fuzzy 匹配。

## Proc source

外部命令执行与 stdout 读取在：

```text
lua/snacks/picker/source/proc.lua
```

`files.lua` 调用：

```lua
return require("snacks.picker.source.proc").proc(
  ctx:opts({
    cmd = cmd,
    args = args,
    notify = not opts.live,
    transform = function(item)
      item.cwd = cwd
      item.file = item.text
    end,
  }),
  ctx
)
```

关键 transform：

```lua
item.cwd = cwd
item.file = item.text
```

也就是说 finder 读到的每一行路径会成为 picker item 的：

- `item.text`：用于默认匹配和展示；
- `item.file`：标记这是文件 item，也用于 filename bonus / path 相关逻辑；
- `item.cwd`：用于 cwd bonus 等逻辑。

## Matcher initialization

核心 matcher 在：

```text
lua/snacks/picker/core/matcher.lua
```

创建 matcher 时默认配置：

```lua
self.opts = vim.tbl_deep_extend("force", {
  fuzzy = true,
  smartcase = true,
  ignorecase = true,
}, opts or {})
```

每次 pattern 改变，会调用：

```lua
M:init(pattern)
```

它会：

1. trim pattern；
2. 增加 tick；
3. 判断是否是 previous pattern 的 subset；
4. 把 pattern 拆成 mods；
5. 支持 OR：`|`；
6. 支持 field pattern：`field:query`；
7. 根据 entropy 排序 mods；
8. 设置 fast path：单一 pattern 时使用 `self.one`。

## Pattern preparation

`M:_prepare(pattern)` 会把用户输入转换成 matcher mods。

重要行为：

### smartcase

```lua
mods.ignorecase = self.opts.ignorecase
local is_lower = mods.pattern:lower() == mods.pattern
if self.opts.smartcase then
  mods.ignorecase = is_lower
end
```

也就是说：

- query 全小写：ignorecase；
- query 包含大写：区分大小写。

### fuzzy / exact modes

默认：

```lua
mods.fuzzy = self.opts.fuzzy
```

特殊前缀会改变模式：

- `!foo`：inverse exact match；
- `'foo`：非 fuzzy，普通 exact contains；
- `'foo'`：word match；
- `^foo`：exact prefix；
- `foo$`：exact suffix。

### field matching

支持类似：

```text
file:foo
```

这会让 matcher 只匹配 item 的指定 field。

### file position patterns

还支持类似：

```text
path/to/file:12:3
path/to/file:12
```

这会设置：

```lua
self.file = {
  path = file,
  pos = { line, col },
}
```

用于跳转到文件位置。

## Matching flow

`M:match(item)` 是总入口。

如果 pattern 为空：

```lua
return M.DEFAULT_SCORE
```

如果是单一 pattern，则走 fast path：

```lua
return self:_match(item, self.one) or 0
```

多个 token 时，每个 token 都必须匹配。OR group 中任意一个匹配即可。

匹配成功后，`M:update(picker, item)` 会：

1. 计算 score；
2. 加上 item-specific `score_add` / `score_mul`；
3. 如果启用 frecency，加 frecency bonus；
4. 如果启用 cwd_bonus，加 cwd bonus；
5. 写入 `item.score`；
6. 把 item 加入 picker list。

## Fuzzy matching algorithm

真正的 fuzzy 子序列匹配在：

```lua
M:fuzzy_find(str, str_orig, pattern, init)
M:fuzzy(str, str_orig, pattern)
```

简化理解如下：

```lua
function fuzzy_match(text, query)
  local pos = 1
  for c in query:gmatch(".") do
    local found = text:find(c, pos, true)
    if not found then
      return false
    end
    pos = found + 1
  end
  return true
end
```

也就是：

1. 找到 query 第一个字符；
2. 从它后面继续找第二个字符；
3. 继续找后续字符；
4. 全部找到就匹配成功。

例如：

```text
候选路径: my/path/foobar.md
query:    mpafbar

m y / p a t h / f o o b a r . m d
m     p a       f     b a r
```

字符按顺序都能找到，所以匹配成功。

## Best fuzzy span search

Snacks 不是只找第一次可行匹配。

`M:fuzzy()` 会：

1. 从第一个可行起点开始匹配；
2. 计算 score；
3. 继续尝试下一个起点；
4. 选择 score 最高的匹配。

源码逻辑：

```lua
local from, to = self:fuzzy_find(str, str_orig, pattern)
if not from then
  return
end

local best_from, best_to, best_score = from, to, self.score.score
while from do
  if self.score.score > best_score then
    best_from, best_to, best_score = from, to, self.score.score
  end
  from, to = self:fuzzy_find(str, str_orig, pattern, from + 1)
end
return best_score, best_from, best_to, str
```

因此它会在多个可能匹配位置中选择评分最好的那一个。

## Match positions

匹配位置用于高亮。

`M:positions(item)` 会对 fuzzy match 调用：

```lua
M:fuzzy_positions(str, pattern, from)
```

逻辑是从最佳起点 `from` 开始，逐个找 query 字符的位置：

```lua
local ret = { from }
for i = 2, #pattern do
  ret[#ret + 1] = string.find(str, pattern[i], ret[#ret] + 1, true)
end
return ret
```

这些位置最终可以被 UI 用来高亮匹配字符，形成 Snacks picker 中的命中高亮效果。

## Scoring implementation

评分逻辑在：

```text
lua/snacks/picker/core/score.lua
```

文件注释说明：

```lua
--- This is a port of the scoring logic from fzf.
```

核心常量：

```lua
local SCORE_MATCH = 16
local SCORE_GAP_START = -3
local SCORE_GAP_EXTENSION = -1

local BONUS_BOUNDARY = SCORE_MATCH / 2
local BONUS_NONWORD = SCORE_MATCH / 2
local BONUS_CAMEL_123 = BONUS_BOUNDARY - 1
local BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION)
local BONUS_FIRST_CHAR_MULTIPLIER = 2
local BONUS_NO_PATH_SEP = BONUS_BOUNDARY - 2
```

### Character classes

Snacks 会把字符分成几类：

- whitespace
- non-word
- delimiter，例如 `/\,:;|`
- lower
- upper
- letter
- number

这些 class 用于判断 boundary、delimiter boundary、camelCase transition 等。

### Boundary bonus

如果当前匹配字符处于边界位置，会加分。

例如：

```text
my/path/foobar.md
   ^    ^
   p    f
```

`p` 和 `f` 都在 `/` 之后，是路径分隔符后的边界，得分更高。

### Consecutive bonus

连续匹配会加分。

例如 query：

```text
bar
```

匹配 `foobar.md` 里的连续 `bar`，比三个字符分散在路径中得分更高。

### Gap penalty

匹配字符之间间隔越大，分数越低。

```lua
self.score = self.score + SCORE_GAP_START + (gap - 1) * SCORE_GAP_EXTENSION
```

### First char multiplier

第一个匹配字符的 bonus 会乘以：

```lua
BONUS_FIRST_CHAR_MULTIPLIER = 2
```

因此起点位置和起点边界非常重要。

### Filename bonus

如果启用 `filename_bonus`，并且匹配起点之后没有路径分隔符，说明匹配发生在文件名部分，会额外加分：

```lua
if
  self.is_file
  and self.opts.filename_bonus
  and not str:find(PATH_SEP, first + 1, true)
then
  self.score = self.score + BONUS_NO_PATH_SEP
end
```

效果：同等条件下，匹配 basename 比匹配上层目录更靠前。

## Sorting

匹配成功后，item 会带上 score。

默认排序配置会按 score 排序，通常是：

```text
score:desc
```

也就是分数越高，结果越靠前。

`matcher.lua` 中还有一些性能优化：

- empty pattern fast path；
- single pattern fast path；
- subset query optimization；
- topk / previous matches 优先处理；
- async yielder 避免阻塞 UI。

## Default mode vs live mode

### Default mode

默认 `Snacks.picker.files()` 的关键体验是：

```text
finder 枚举所有候选文件
        ↓
matcher 对当前 query 做 fuzzy 子序列匹配
        ↓
score 排序
        ↓
UI 展示并高亮 positions
```

所以 `mpafbar` 能匹配 `my/path/foobar.md`。

### Live mode

files source 有：

```lua
supports_live = true
```

开启 live 后，query 会进入 finder 的 `filter.search`，进而影响外部命令参数。此时更接近：

```sh
fd mpafbar
```

这时结果更依赖外部命令自身的搜索行为，不完全等同于默认 matcher 的 fuzzy 子序列匹配。

## Why `mpafbar` matches `my/path/foobar.md`

完整过程：

1. `fd` 或 fallback command 先枚举出：

   ```text
   my/path/foobar.md
   ```

2. 该路径成为 picker item：

   ```lua
   item.text = "my/path/foobar.md"
   item.file = "my/path/foobar.md"
   ```

3. matcher 把 query `mpafbar` 拆成字符：

   ```text
   m p a f b a r
   ```

4. fuzzy matcher 在完整路径中按顺序查找这些字符：

   ```text
   my/path/foobar.md
   m  p a    f  b a r
   ```

5. 匹配成功后，score.lua 给这个匹配打分：

   - `m` 位于开头，有 first char bonus；
   - `p`、`f` 位于路径边界后，有 delimiter boundary bonus；
   - `bar` 连续匹配，有 consecutive bonus；
   - 跨越较大间隔时也会有 gap penalty。

6. UI 使用 matched positions 高亮命中字符。

## Key takeaways for porting

如果要把 Snacks 的体验移植到其他 autocomplete / picker 中，重点不是构造：

```sh
fd query
```

而是：

1. 用 `fd` / `rg --files` / `find` 枚举候选；
2. 缓存候选列表；
3. 在应用内部做 fuzzy 子序列匹配；
4. 用 fzf 风格 scoring 排序；
5. 记录 positions 用于高亮；
6. 只有 live mode 或特殊搜索模式才把 query 传给外部命令。

这也是 `extensions/fuzzy-at.ts` 在 pi 中实现 `@` fuzzy 文件查找时采用的方案。
