// 真实静态研究验收的跨端材料；包含可引用的契约矛盾与状态/取消缺陷，不执行应用代码。
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
export const PROFILE_RESEARCH_FILES: Record<string, string> = {
  "requirements/spec.md": `# 会话刷新需求\n产品支持 iOS、安卓和 Web；用户切回应用时刷新登录状态。\nPOST /api/session/refresh 接受 refreshToken，请求重复时应返回同一有效结果。\n响应字段为 accessToken: string 与 expiresAt: epoch milliseconds。\n401 表示凭证失效；网络断开应保留已有会话并允许重试。\n验收目前只要求正常登录成功；并发、取消、弱网和无障碍尚未定义详细用例。\n市场、用户访谈和具体设备版本未提供，不可虚构。\n`,
  "ios/SessionStore.swift": `import Foundation\nfinal class SessionStore {\n  var accessToken: String?\n  func refresh(_ client: SessionClient) async throws {\n    let payload = try await client.refresh()\n    accessToken = payload["token"] as? String\n  }\n}\n`,
  "android/SessionViewModel.kt": `class SessionViewModel : ViewModel() {\n  var token: String? = null\n  fun refresh(client: SessionClient) = viewModelScope.launch {\n    try { token = client.refresh()["token"] }\n    catch (error: Exception) { token = null }\n  }\n}\n`,
  "web/Login.tsx": `import { useState } from 'react';\nexport function Login() {\n  const [busy, setBusy] = useState(false);\n  const [token, setToken] = useState<string>();\n  const [error, setError] = useState('');\n  async function refresh() {\n    setBusy(true);\n    try {\n      const response = await fetch('/api/session/refresh', { method: 'POST' });\n      const payload = await response.json();\n      setToken(payload.token);\n    } catch { setError('登录失败'); }\n    setBusy(false);\n  }\n  return <form onSubmit={event => { event.preventDefault(); void refresh(); }}>\n    <button disabled={busy}>继续</button><span>{error}</span><span>{token}</span>\n  </form>;\n}\n`,
  "server/SessionController.java": `@RestController\npublic class SessionController {\n  @PostMapping("/api/session/refresh")\n  public Map<String, Object> refresh(@RequestBody RefreshRequest request) {\n    var session = repository.findByRefreshToken(request.refreshToken());\n    repository.delete(session);\n    var replacement = issuer.issue(session.userId());\n    repository.save(replacement);\n    return Map.of("access_token", replacement.token(), "expiresAt", replacement.expirySeconds());\n  }\n}\n`,
  "design/interaction.md": `# 登录交互草案\n提交时禁用继续按钮，但没有请求状态文案或辅助技术播报。\n错误仅放在按钮后的小段文本中；错误后焦点、重试、弱网保留状态未说明。\n移动端和 Web 使用同一份布局草图，未提供平台专用组件或尺寸规则。\n转场固定 700ms，转场期间阻止所有点击；没有减少动态效果的替代规则。\n这是文字草案，没有设计稿、Figma 链接或真实用户测试。\n`,
  "tests/session.test.ts": `import { strict as assert } from 'node:assert';\nexport async function acceptsRefresh(client) {\n  const response = await client.post('/api/session/refresh');\n  assert.equal(response.status, 200);\n}\n// 尚无响应字段、时间单位、401、网络断开、并发刷新或取消用例。\n`,
};
export const PROFILE_RESEARCH_OBJECTIVE =
  "只读研究这份跨端登录刷新材料：requirements/spec.md 定义服务契约与验收，ios/、android/、web/、server/、design/、tests/ 各有实际实现或草案。每位专家按自身领域给3条带准确完整单行证据的核心结论，区分已确认需求、静态推断、建议和未验证。核对 accessToken 字段和 expiresAt 毫秒、并发幂等、取消/弱网状态、UI 反馈/无障碍与验收遗漏。通用实现角色聚焦 web/Login.tsx，通用验证角色聚焦 tests/session.test.ts。正式 iOS 专家请按任务包清单实际读取 swiftui-ui-patterns 的一个相关 references 资源，并说明 SwiftUI 方法对当前 Foundation 类的适用限制。其他专家可以按需读取冻结资源。互审必须逐项保留契约矛盾或证据不足，不能把外部依赖缺失当作结论正确。本次不执行命令、测试、设备或联网，不修改文件、不读取其他专家首轮报告。";
export async function writeProfileResearchFixture(root: string) {
  for (const [path, text] of Object.entries(PROFILE_RESEARCH_FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}
