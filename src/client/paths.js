/** Last path segment ("/a/b/" → "b"); "/" stays "/", and empty input yields "". */
export const basename = (path) => (typeof path === "string" ? path.split("/").filter(Boolean).at(-1) || path : "");
