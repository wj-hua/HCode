// 用户已确定的固定组合；导入职责和方法，不继承角色文件中的模型、沙箱或工具。
import type { BusinessExpertType } from "../../../../shared/expertProfiles.js";
interface Definition {
  roles: string[];
  skills: string[];
  limitations: string[];
  reviewers: BusinessExpertType[];
}
const UI_RULE =
  "apple-design 仅作为层级、反馈、交互和无障碍方法；原生端遵循项目平台，不照搬 Web 代码。";
export const PROFILE_DEFINITIONS: Record<BusinessExpertType, Definition> = {
  ios: {
    roles: ["swift-expert", "mobile-app-developer", "mobile-developer"],
    skills: [
      "apple-design",
      "build-ios-apps:swiftui-ui-patterns",
      "build-ios-apps:swiftui-performance-audit",
      "build-ios-apps:ios-debugger-agent",
    ],
    limitations: [
      UI_RULE,
      "SwiftUI 方法仅适用于 SwiftUI 项目；未接入 XcodeBuildMCP、模拟器或真机，不能声称已完成构建、性能或设备验证。",
    ],
    reviewers: ["design", "testing", "java", "android"],
  },
  android: {
    roles: ["kotlin-specialist", "mobile-app-developer", "mobile-developer"],
    skills: ["apple-design", "architecture-deepening", "bug-diagnosis"],
    limitations: [
      UI_RULE,
      "只按实际 Kotlin/Java、Compose/View 和 SDK 分析；本阶段未开放 Gradle、设备、权限与弱网测试。",
    ],
    reviewers: ["design", "testing", "java", "ios"],
  },
  frontend: {
    roles: ["frontend-developer", "react-specialist"],
    skills: ["apple-design", "frontend-skill", "architecture-deepening"],
    limitations: [
      UI_RULE,
      "React 职责仅作用于 React 项目；本阶段未开放浏览器、构建、截图或网页发布。",
    ],
    reviewers: ["design", "testing", "java"],
  },
  java: {
    roles: ["java-architect", "spring-boot-engineer", "architect-reviewer"],
    skills: ["architecture-deepening", "tdd-quality"],
    limitations: [
      "Spring 职责仅作用于实际 Spring 项目；本阶段未开放 JDK/数据库/集成或性能测试，不迁移框架。",
    ],
    reviewers: ["frontend", "ios", "android", "testing"],
  },
  requirements: {
    roles: [
      "business-analyst",
      "research-analyst",
      "market-researcher",
      "ux-researcher",
    ],
    skills: ["task-slicing"],
    limitations: [
      "未开放联网、用户访谈或市场资料检索；没有业务确认和来源的需求、竞品与市场结论必须标为假设。",
    ],
    reviewers: ["testing", "design"],
  },
  design: {
    roles: ["ui-designer", "ux-researcher"],
    skills: [
      "apple-design",
      "frontend-skill",
      "product-design:index",
      "product-design:audit",
    ],
    limitations: [
      UI_RULE,
      "本阶段使用设计研究/审查方法，未接入 Product Design 宿主、Figma、图片生成或浏览器；这些技能的插件/skill://资源与制作步骤不能运行，不能虚构设计产物。",
    ],
    reviewers: ["frontend", "ios", "android", "testing"],
  },
  testing: {
    roles: ["qa-expert", "test-automator", "accessibility-tester"],
    skills: ["tdd-quality", "bug-diagnosis"],
    limitations: [
      "角色与 Skills 中实施/运行测试要求与只读阶段冲突：本阶段只产出风险、用例和验证计划；命令、设备和辅助技术检查均未执行。",
    ],
    reviewers: ["requirements", "java", "frontend"],
  },
};
export const PROFILE_SCOPE =
  "本阶段仅只读研究/审查。保留完整原职责和 Skill 文本，但其中写入、执行、联网、安装、插件调用和提权步骤不适用；在报告中说明未执行的步骤和缺口。导入仅为指令加载，不代表原生 Skill 或插件已接入。";
