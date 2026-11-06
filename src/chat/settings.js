// Shared UI/validation data; backend enforcement lives in native/src/settings.rs.
import contract from "../../native/agent-settings.json" with { type: "json" };
export const EFFORTS = Object.freeze(contract.efforts);
export const PERMISSIONS = Object.freeze(contract.permissions);
export const DEFAULT_SETTINGS = Object.freeze(contract.defaults);
