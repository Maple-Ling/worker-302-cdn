# Lucky Webhook + Cloudflare Worker · 动态跳转与 CDN 代理 · 部署与配置文档

> **用途**：Lucky 的 STUN 穿透端口是动态的，通过 Worker + KV 把「子域名 → 当前 IP:端口」的映射记下来。
> 访问 `<前缀>.<DDNS域名>` 时自动 302 跳到家里对应的服务；对**不支持 302 跳转**的 App，
> 可把单个前缀切到 **CDN 代理模式**，由 Cloudflare 边缘直接回源，地址栏恒定不变。

## 两种模式一览

| | **302 跳转**（默认） | **CDN 代理** |
|---|---|---|
| 访问域名 | `<前缀>.<DDNS域名>` | `<前缀>.<CDN域名>` |
| 浏览器行为 | 跳转后地址栏变成 `IP:端口` | 地址栏恒为域名，**App 完全兼容** |
| 流量路径 | 浏览器直连家里 IP:端口 | Cloudflare 边缘回源 IP:端口 |
| 切换方式 | 管理页点「切回 302」 | 管理页点「切到 CDN」 |
| 前置要求 | 无 | 需 `CF_API_TOKEN` + `<CDN域名>` 泛解析 |

> **本文示例域名**：统一使用 `ddns.example.com`（DDNS 入口域名）与 `cdn.example.com`（CDN 代理域名），
> 请替换为你自己的域名。二者关系是**首段替换**：`ddns.example.com` → `cdn.example.com`。

---

## 一、环境变量（Cloudflare Worker → Settings → Variables and Secrets）

| 变量名 | 必填 | 示例值 | 说明 |
|---|---|---|---|
| `DDNS_DOMAIN` | ✅ | `ddns.example.com` | **不带子域前缀**。用于：① 管理页生成 Webhook 地址；② 判断请求是走跳转还是显示管理页；③ 列表页显示访问地址。**删了 Worker 会直接报「缺少 DDNS_DOMAIN 环境变量」**。必须是「一层子域 + 主域」格式（如 `ddns.example.com`），多层子域或裸主域会导致根域/CDN 域名推导错误 |
| `AUTH_TOKEN` | ✅ | 自己生成的长随机串 | Bearer Token。**Lucky 上报用它**；管理页登录后经 `/__admin_config` 获取，**不再随页面源码下发** |
| `ADMIN_PASSWORD` | ✅ | `******`（建议改强密码） | 管理页登录密码，用于换取 **HMAC 签名会话令牌**（有效期 12 小时）。令牌本身即鉴权凭据 |
| `CF_API_TOKEN` | 可选 | Cloudflare API Token | **CDN 代理模式必需**。缺省时 CDN 切换返回 501 |
| `CF_ZONE_ID` | 可选 | Zone ID | 留空则自动按 `DDNS_DOMAIN` 的根域查询（首次调用多一次 API） |
| `CDN_DOMAIN` | 可选 | `cdn.example.com` | CDN 模式的访问域名。**留空则自动把 `DDNS_DOMAIN` 首段替换为 `cdn`** |

> ⚠️ `CF_API_TOKEN` 拥有域名 DNS + 规则写权限，**只填环境变量，绝不要提交到代码仓库或发给他人**。

> 改完变量后需要**重新部署**一次才生效。

### `CF_API_TOKEN` 需要的权限

| 权限 | 必需性 | 用途 |
|---|---|---|
| `Zone → Zone → Read` | 可选 | 自动推导 Zone ID（若已填 `CF_ZONE_ID` 则不需要） |
| `Zone → DNS → Edit` | 必需 | 创建/更新 `<CDN域名>` 的泛解析 A 记录 |
| `Zone → Origin Rules → Edit` | 必需 | 创建/删除改回源端口的规则 |
| `Zone → Config Settings → Write` | 可选 | 自动把 `<CDN域名>` 设为 Flexible SSL（缺失时可在面板手动设） |

> **Zone Resources 必须限定到本域名**（单个 Zone），不要给「所有 Zone」。
>
> 权限若缺失，切换 CDN 时会返回 502，错误详情会指明是哪一步失败。

## 二、KV 绑定

| 项目 | 值 |
|---|---|
| 绑定变量名（Binding name） | **`proxy`**（代码里是 `env.proxy`，名字必须完全一致） |
| 命名空间 | 自建，任意名字 |

## 三、KV 键结构

| 键 | 值示例 | 说明 |
|---|---|---|
| `global:host` | 111.111.111.111 | **全局公网 IP，所有服务共用一条**。由 Lucky 上报时写入（每次都覆盖） |
| `<前缀>:port` | `22843` | 每个服务的穿透端口。更新时间存在该键的 **metadata**（`updated_at`），不额外占键 |
| `<前缀>:host` | `1.2.3.4`（可选） | 手动添加时才存在。用于给**单个前缀**指定专用 IP，**优先级高于 `global:host`**（比如以后某台 VPS 也走这套） |
| `<前缀>:mode` | `redirect` / `proxy` | 访问模式。**不存在时默认 `redirect`**。由管理页 `__set_mode` 写入，Lucky 上报不碰此键 |

示例（3 个服务）：

```
global:host  = 111.111.111.111
piweb:port   = 22843
fnos:port    = 24711
pc:port      = 3389
```

## 四、Cloudflare 配置

| 项目 | 配置 |
|---|---|
| **Worker 路由** | `*.<DDNS域名>/*`（如 `*.ddns.example.com/*`），Zone = `example.com` |
| **DNS 泛解析** | `*.<DDNS域名>` → **橙云（Proxied）**，必须存在，这是访问入口 |
| `<DDNS域名>` 的 A 记录 | **可以删除**（跳转不再依赖它，改用 KV 里的 IP） |

> ⚠️ 注意区分：**DNS 泛解析** 和 **Worker 路由** 是两套东西，都要配。
> 二级子域通配 `*.ddns.example.com` 不会影响 `example.com` 下的其他一级子域，给别的 VPS 用域名互不干扰。

### 路由通配符写法（容易踩坑）

Cloudflare 路由里 `*` 匹配**零个或多个任意字符**，因此：

| 写法 | 匹配范围 | 建议 |
|---|---|---|
| `*ddns.example.com/*` | 以 `ddns.example.com` **结尾**的主机名，含裸域 `ddns.example.com` 与 `foo<ddns.example.com>` 这类非子域 | ❌ 语义不精确 |
| `*.ddns.example.com/*` | 仅 `<任意前缀>.ddns.example.com` 子域 | ✅ **推荐** |

> 两种写法都能匹配你的服务子域，但**推荐用 `*.ddns.example.com/*`**：语义精确、避免「域名后缀混淆」隐患。
> 若同时需要裸域也走 Worker，再额外加一条 `ddns.example.com/*`。

## 五、Lucky Webhook 配置（每个服务一条）

| 字段 | 值 |
|---|---|
| URL | `http://<前缀>.<DDNS域名>/__update_port` |
| 方法 | `POST` |
| 请求头 | `Authorization: Bearer <AUTH_TOKEN>` |
| 请求体 | `{"sub":"<前缀>","host":"#{ip}","port":"#{port}"}` |

Lucky 支持的变量（实测）：

```
#{time}      触发 Webhook 的时间
#{ipAddr}    当前 STUN 穿透获得的公网 IP 地址（含端口），如 192.168.1.1:16666
#{ip}        公网 IP 的 IP 部分，如 192.168.1.1      ← 我们用这个
#{port}      公网 IP 地址中的端口部分，如 16666       ← 我们用这个
#{ruleName}  规则名称
```

> 多个服务 = 多条 Webhook，**只有 `sub` 不同**，其余完全一样。
> Lucky 保存配置时会测试一次，端口变化时会再上报，每次都会刷新 KV。
> **切换模式完全不需要改 Lucky 配置**，模式存在 KV 的 `<前缀>:mode` 里。

## 六、请求处理流程

```
浏览器  http://piweb.ddns.example.com/
   │  （DNS 泛解析 → Cloudflare，路由匹配 → Worker）
   ▼
Worker  读 KV：global:host = 111.111.111.111
              piweb:port  = 22843
   ▼
302  →  http://111.111.111.111:22843/        （路径和查询参数原样保留）


Lucky   POST /__update_port  {"sub":"piweb","host":"111.111.111.111","port":"22843"}
   ▼
Worker  写 KV：global:host、piweb:port（带 metadata.updated_at）
```

**跳转目标优先级**：`<前缀>:host`（手动专用）→ `global:host` → DoH 解析 `DDNS_DOMAIN` → 回退用域名。

**若该前缀为 proxy 模式**：访问 `<前缀>.<DDNS域名>` 时 Worker 会 302 引导到 `<前缀>.<CDN域名>`，
真正的内容由 Cloudflare 边缘经 Origin Rules 直接回源（不经过 Worker）。

## 七、API 端点一览

| 端点 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/` `/admin` | GET | 无 | 管理页（HTML，含登录门禁）。**只注入非敏感配置** |
| `/__admin_check_password` | POST | 无 | 校验密码，成功返回会话令牌 |
| `/__admin_config` | GET | 会话令牌 | 登录后获取 `AUTH_TOKEN` / 域名等（管理页据此生成 Lucky 配置） |
| `/__update_port` | POST | `AUTH_TOKEN` | Lucky 上报，写 KV。支持单条对象或数组；**若该前缀为 proxy 模式，同步 Origin Rule 与 CDN 泛解析** |
| `/__get_port?sub=x` | GET | 会话令牌 或 `AUTH_TOKEN` | 查询单个前缀（含 `mode`） |
| `/__list_ports` | GET | 会话令牌 或 `AUTH_TOKEN` | 列出全部前缀（含 `mode`） |
| `/__set_mode` | POST | 会话令牌 或 `AUTH_TOKEN` | 切换模式（body: `{"sub":"x","mode":"proxy"\|"redirect"}`），自动部署/移除 Origin Rule |
| `/__delete_port` | POST | 会话令牌 或 `AUTH_TOKEN` | 删除某前缀（body: `{"sub":"x"}`）；proxy 模式会连带删除 Origin Rule |
| 其他任意路径 | * | 无 | 按 Host 取前缀 → 302 跳转到 `http://<host>:<port><原路径>`；若该前缀为 proxy 模式，则 302 到 `http://<sub>.<CDN域名><原路径>` |

> 鉴权说明：`Authorization: Bearer <token>` 中的 token 可以是 `AUTH_TOKEN`（Lucky/脚本用），也可以是管理页登录后拿到的会话令牌。

## 八、部署步骤（从零开始）

1. **创建 KV 命名空间**，在 Worker 里绑定，Binding name 填 `proxy`
2. **设置环境变量**：`DDNS_DOMAIN`、`AUTH_TOKEN`、`ADMIN_PASSWORD`
3. **部署 `worker.js`**
4. **添加 Worker 路由**：`*.<DDNS域名>/*`（推荐写法，Zone: `example.com`）
5. **添加 DNS 记录**：`*.<DDNS域名>`（橙云 Proxied）
6. **Lucky 里配 Webhook**：URL / 方法 / 请求头 / 请求体（见第五节）
7. **打开管理页** `https://proxy.<你的worker>.workers.dev/admin` 或 `http://任意前缀.<DDNS域名>/admin`，输入 `ADMIN_PASSWORD` 登录
8. **输入前缀 → 生成配置 → 复制到 Lucky → 保存**
9. **点「刷新列表」**确认端口和跳转目标已出现

> **要启用 CDN 模式**：再补第 4 步之外的准备（见第十节「CDN 模式一次性准备」），然后重新部署。

## 九、管理页功能

- 登录（密码 = `ADMIN_PASSWORD`）→ 返回 **HMAC 签名会话令牌**，存 sessionStorage，有效期 12 小时
- 输入前缀生成 Lucky Webhook 配置（一键复制）。`AUTH_TOKEN` 于登录后经 `/__admin_config` 拉取，**不在页面源码中**
- 已配置列表：前缀 / 端口 / **模式** / 跳转目标 / 访问地址 / 更新时间 / 切换 / 删除
- **模式切换**（核心功能）：
  - 点「切到 CDN」→ 自动创建 CF Origin Rule（`<前缀>.<CDN域名>` → 当前端口）+ 同步 CDN 泛解析 + 设置 Flexible SSL，KV 写 `mode=proxy`
  - 点「切回 302」→ 自动删除 Origin Rule，KV 写 `mode=redirect`
  - 未配 `CF_API_TOKEN` 时按钮禁用，接口返回 501
  - 访问地址列会**随模式自动切换**显示（proxy 显示 `<CDN域名>`，redirect 显示 `<DDNS域名>`）
- 「删除」只清 KV；proxy 模式会连带删除 Origin Rule。**若 Lucky 里对应 Webhook 还在跑，下次上报会重新写回来**，要彻底删需先在 Lucky 删掉该 Webhook

## 十、两种模式详解

### 工作原理（为什么必须用两个域名）

```
302 模式：
  <前缀>.<DDNS域名> → 【Worker 路由拦截】→ 302 → 浏览器直连 http://IP:端口

CDN 模式：
  <前缀>.<CDN域名> → 橙云 → 【不经过 Worker】→ Origin Rules 改端口 → 回源 http://IP:端口
```

> **关键**：Worker 路由与 Origin Rules 在同一域名上互斥（Worker 拦下请求后，同 zone 子请求会绕过 CF 管线）。
> 因此 CDN 模式必须使用**独立域名** `*.<CDN域名>`，让请求完全不进 Worker，才能由 CF 边缘直接回源。
> 若你访问旧的 `<前缀>.<DDNS域名>`，Worker 会自动 302 引导到 `<前缀>.<CDN域名>`。

### 模式对比

| | **302 跳转**（默认） | **CDN 代理** |
|---|---|---|
| 访问域名 | `<前缀>.<DDNS域名>` | `<前缀>.<CDN域名>` |
| 浏览器行为 | 跳转后地址栏变成 `IP:端口` | 地址栏恒为域名，**App 完全兼容** |
| 流量路径 | 浏览器直连家里 IP:端口 | Cloudflare 边缘回源 IP:端口 |
| 端口限制 | 无 | 无（Origin Rules 支持 1–65535） |
| 免费额度 | 无限制 | **Origin Rules 免费版限 10 条** |
| 登录态 | 因地址变化可能失效 | 永久保持 |
| 前置要求 | 无 | 需 `CF_API_TOKEN` + `<CDN域名>` 泛解析 |

### CDN 模式一次性准备（部署时做一次）

1. **建泛解析**：`*.<CDN域名>` → A 记录（内容随意，Worker 会自动更新为公网 IP），**橙云 Proxied**
2. **创建 API Token**：Cloudflare → My Profile → API Tokens → 用「Edit zone DNS」模板，再加 `Zone → Origin Rules → Edit`（可选 `Zone → Config Settings → Write`），**Zone Resources 限定到本域名**
3. **填环境变量**：`CF_API_TOKEN`（必填）、`CF_ZONE_ID`、`CDN_DOMAIN`（后两个可留空自动推导）
4. 重新部署 Worker

> SSL：Worker 会自动为 `<CDN域名>` 下发 Configuration Rule 设 `SSL=flexible`（家宽回源是明文 http）。
> 若该步骤失败会返回 warning，也可手动在 CF 面板 → SSL/TLS → 把该域设 Flexible。
> **HTTPS 提示**：`*.<CDN域名>` 仍是二级子域，免费证书不覆盖，只能用 `http://`。要 HTTPS 需开 Total TLS 或改用一级子域。

## 十一、已知限制与代价

1. **只能用 `http://`**：`*.<DDNS域名>` 和 `*.<CDN域名>` 都是二级子域，Cloudflare 免费证书不覆盖，HTTPS 握手会失败。若想用 HTTPS，需在 Cloudflare 开 **Total TLS**，或改用一级子域（`piweb.example.com`，证书覆盖 `*.example.com`）
2. **跳转后地址栏变成 `IP:端口`**（仅 302 模式）：与域名不同源，cookie / localStorage 不通用，**登录态会因 IP 或端口变化而失效，需要重登一次**（IP 和端口都不变时，登录态是保留的）。**CDN 模式无此问题**
3. **CDN 模式需 `CF_API_TOKEN`**：该 Token 有域名 DNS + 规则写权限，务必限定单 Zone，且**只存环境变量**
4. **Origin Rules 免费版限 10 条**：即最多 10 个服务可切 CDN 模式（超限切换会返回 502）
5. **CDN 模式回源走明文 http**：Worker 会自动设 `SSL=flexible`；若失败可手动在 CF 面板设置
6. **CF 免费版 ToS 2.8 条**：不建议用 CDN 模式代理大量非 HTML 内容（视频、大文件下载、WebDAV），可能被警告
7. **CDN 模式占用 Worker 请求额度吗？不占**：请求不进 Worker，由 CF 边缘直接回源
8. **无法改成反向代理（不依赖 Origin Rules）**：Cloudflare Workers 出站请求只允许标准端口（HTTP: 80/8080/8880/2052/2082/2086/2095，HTTPS: 443/2053/2083/2087/2096/8443），22843 这类端口 fetch 不到，所以 Worker 自身无法直连回源
9. **AUTH_TOKEN 明文传输**（因为走 http）
10. **KV 写入量**：免费额度 1000 次/天，Lucky 上报频率远用不完
11. **`DDNS_DOMAIN` 必须是「一层子域 + 主域」格式**：如 `ddns.example.com`。推导逻辑是「剥掉首段得根域」+「首段换成 cdn 得 CDN 域名」，只有这个格式才成立：
    - 多层子域 `a.b.example.com` → 根域错成 `b.example.com`、CDN 域名错成 `cdn.b.example.com`
    - 裸主域 `example.com` → CDN 域名错成 `cdn.com`（根域本身正确）
    - 两段式后缀主域 `example.co.uk` → 裸主域会错成 `co.uk`、CDN 域名错成 `cdn.co.uk`
12. **`/__list_ports` 存在 N+1 次 KV 读取**：每个前缀要读 `:port`、`:host`、`:mode` 三个键，前缀很多时列表会略慢

## 十二、排错对照表

| 现象 | 原因 / 处理 |
|---|---|
| `{"error":"服务器配置错误","detail":"缺少 XXX 环境变量"}` | 环境变量没配或删了，补上并重新部署 |
| `{"error":"服务器配置错误","detail":"缺少 proxy KV 绑定"}` | KV 绑定名不是 `proxy` |
| 点登录按钮毫无反应 | 页面 JS 语法错误（历史 bug：模板字符串里的 `\n` 被提前转义，已修复） |
| 登录报 500「未设置 ADMIN_PASSWORD」 | 环境变量漏配 `ADMIN_PASSWORD` |
| 点「切到 CDN」报 501 | 未配置 `CF_API_TOKEN` 环境变量 |
| 点「切到 CDN」报 502 | Origin Rules 配额已满（免费版 10 条），或 Token 缺少 `Zone → Origin Rules → Edit` 权限 |
| 切换成功但 `<CDN域名>` 打不开 | 检查：① `<CDN域名>` 泛解析是否存在且**橙云**；② `CDN_DOMAIN` 推导是否正确；③ 家里端口映射；④ `global:host` 是否最新 |
| CDN 模式返回 522 / 连接超时 | CF 回源到家里失败：端口映射没生效，或回源 IP 不对（看 `global:host`） |
| CDN 模式回源 https 握手失败 | 手动把 `<CDN域名>` 的 SSL 模式设为 **Flexible** |
| 切回 302 后 `<CDN域名>` 仍能访问 | CF 规则传播有延迟，等几秒；或到 CF 面板检查 Origin Rules 是否已清空 |
| 访问 `<前缀>.<DDNS域名>` 被跳到 `<CDN域名>` | 正常：该前缀处于 proxy 模式，Worker 自动引导 |
| 管理页登录后列表一直「加载失败」 | 会话令牌过期（12 小时），重新登录即可 |
| 访问域名直接进了管理页 | 历史 bug：`path === '/'` 被管理页无条件截获，已修复为「DDNS 子域根路径走跳转」 |
| **刚加完 DNS 记录 / 改完路由，访问报 NXDOMAIN 或连不上** | **DNS 全球传播延迟**。用 `--doh-url` 或 DoH 网页查询复核；本机 DNS 缓存旧结果时执行 `ipconfig /flushdns`。**先确认 DoH 能解析，再等 1–5 分钟** |
| **路由用 `*域名` 时，裸域或奇怪主机名也进了 Worker** | `*` 匹配任意字符（含空）。改用 `*.域名/*` 只匹配子域 |
| 跳到目标后返回 `403 Untrusted request` | 目标服务（如 Next.js dev server）做了 Host 校验，只认 IP/localhost。用 IP 跳转即可绕过，或改目标服务的 Host 白名单 / 改用生产模式 |
| **CDN 模式返回 403，但直连 `IP:端口` 正常** | **CDN 回源时 Host 头是域名**（`<前缀>.<CDN域名>`），目标服务做了 Host 白名单校验。把该域名加入服务的允许列表即可（例：Pi Web 需设 `PI_WEB_ALLOWED_HOSTS`） |
| 列表里看不到刚配的前缀 | 历史 bug：前缀是写死的，已改为遍历 KV。若仍看不到，等几秒（KV 有传播延迟） |
| `xxx.<DDNS域名>:22843` 连不上 | 橙云域名 + 非标准端口，Cloudflare 不代理，属正常现象，必须走 Worker 跳转 |
| 跳转后打不开 | 检查：① 路由器端口映射；② 目标服务是否在监听；③ KV 里的 `global:host` 是否是最新 IP |
| 换了网络/端口后跳转失败 | Lucky 没触发上报。确认 Webhook 的触发条件，必要时手动保存一次配置 |
| Token 报 `1000 Invalid API Token` | Token 无效或权限不足。注意要**限定单 Zone**，并在**用户级**页面（My Profile → API Tokens）创建 Token |

## 十三、HTTPS 方案（备选，未采用）

若将来要 HTTPS + 稳定登录态（地址栏恒定），推荐 **Cloudflare Tunnel**：家里跑 `cloudflared`，把域名直接映射到 `localhost:<端口>`：

```yaml
ingress:
  - hostname: piweb.ddns.example.com
    service: http://localhost:22843
  - service: http_status:404
```

优点：地址栏永远是域名（cookie 永久有效）、无需端口映射、支持任意端口、可上 HTTPS。
代价：家里要常驻 `cloudflared` 进程，且二级子域仍需 Total TLS 才能用 HTTPS。

> **为什么不用 Tunnel 实现 CDN 模式**：Tunnel 需要家里常驻 `cloudflared` 进程，
> 而 Cloudflare API **无法创建/管理这个进程**，做不到「管理页一键切换」。
> Origin Rules 则可以通过 API 随时创建/删除，因此被选为 CDN 模式的实现方式。

## 附：项目文件说明

| 文件 | 说明 |
|---|---|
| `worker.js` | Worker 主程序（单文件，含管理页 HTML） |
| `部署与配置文档.md` | 本文档 |
| `worker302.rar` | 历史打包文件（旧版本快照） |
