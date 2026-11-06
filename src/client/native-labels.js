/**
 * English chrome labels for native DSH blocks, mirroring the strings DSH's own
 * conversation uses. Frozen so memoized primitives receive stable identities.
 */
const CODE_TOOLBAR = Object.freeze({ codeLabel: "Code", wrapLabel: "Wrap", unwrapLabel: "Unwrap" });

export const MARKDOWN_LABELS = Object.freeze({
  code: Object.freeze({ copyLabel: "Copy", copiedLabel: "Copied", toolbarLabels: CODE_TOOLBAR }),
  footnotes: "Footnotes",
});

export const TERMINAL_LABELS = Object.freeze({
  commandLine: (line) => `Command line ${line}`,
  signal: (signal) => `signal ${signal}`,
  exitCode: (code) => `exit code ${code}`,
  noExitCode: "no exit code",
  running: "Running",
  failed: "Failed",
  done: "Done",
  copy: "Copy",
  copied: "Copied",
  noOutput: "No output",
  collapseAria: "Collapse output",
  collapse: "Collapse",
  expandAria: (hidden) => `Expand the remaining ${hidden} output lines`,
  expand: (hidden) => `… ${hidden} more lines`,
});

export const DIFF_LABELS = Object.freeze({
  ...CODE_TOOLBAR,
  copy: "Copy",
  copied: "Copied",
  collapseAria: "Collapse diff",
  collapse: "Collapse",
  expandAria: (count) => `Expand ${count} more diff lines`,
  expand: (count) => `… ${count} more lines`,
});
