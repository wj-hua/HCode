// 打包配置：只打包构建产物（main/preload 已把依赖全部 bundle 进去），不带 node_modules。
module.exports = {
  appId: "com.mino.hcode",
  productName: "HCode",
  directories: { output: "release", buildResources: "resources" },
  files: ["out/**/*", "!out/**/*.map", "!out/test/**", "package.json"],
  asar: true,
  npmRebuild: false,
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }],
    icon: "resources/icon.icns",
    category: "public.app-category.developer-tools",
    // 本地自用构建不签名
    identity: null,
    darkModeSupport: true,
  },
  dmg: { title: "HCode ${version}" },
};
