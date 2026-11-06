import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const name = "remote-agents-import-skill";
export const inject = ["skills"];
const skillUrl = new URL("../skills/herdr-import/SKILL.md", import.meta.url);
const resourceBase = {
  kind: "directory",
  path: fileURLToPath(new URL("../", import.meta.url)),
};
const candidate = {
  name: "herdr-import",
  description:
    "将 Herdr 的机器目录与项目路径静态配置导入 DSH Remote Agents。用户要求导入 Herdr 机器、项目、endpoints.json 或 session.json 时使用；先预览、用户确认后导入，不控制活动会话。",
  invocation: { modelInvocable: true, userInvocable: true },
  provider: name,
  source: "bundled",
  resourceBase,
  // DSH 0.2.2-rc.1 BUNDLED_SKILL_RANK, matching the pinned SDK contract.
  rank: 600,
  locator: skillUrl,
};
export function apply(ctx) {
  ctx.skills.registerProvider(() => ({
    name,
    list: async () => [candidate],
    get: async () => ({
      ...candidate,
      content: await readFile(skillUrl, "utf8"),
    }),
  }));
}
