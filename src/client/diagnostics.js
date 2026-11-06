/** Present recovery steps, retaining the original error as diagnostic evidence. */
export function diagnose(error, provider = '') {
  const text = typeof error === 'string' ? error : error?.message || '';
  if (/limit|quota|rate.?limit|429/i.test(text)) return { title: 'Usage limit reached', action: 'Wait for the account limit to reset, then send again explicitly. Your conversation is preserved.', detail: text };
  if (/login|log.in|sign.in|unauthori[sz]ed|authentication|401|oauth/i.test(text)) return { title: 'Sign-in required', action: `Open ${provider || 'the agent'} on this machine in a terminal and sign in, then refresh CLI status.`, detail: text };
  if (/unsupported version|requires .*\d|incompatible/i.test(text)) return { title: 'CLI version is incompatible', action: 'Open CLI versions & updates to inspect the supported target and installation method.', detail: text };
  if (/not found|not installed/i.test(text)) return { title: 'CLI is not installed', action: 'Install the supported CLI on the selected machine and sign in there, then refresh CLI status.', detail: text };
  if (/timeout|timed out|ETIMEDOUT|SIGTERM/i.test(text)) return { title: 'Connection timed out', action: 'Check the host connection and CLI startup, then refresh. Requests are not resent automatically.', detail: text };
  if (/SSH|connection|network|offline|known_hosts/i.test(text)) return { title: 'Host connection unavailable', action: 'Use Machines & projects to test the connection. Check your SSH alias and known_hosts, then refresh.', detail: text };
  return { title: 'Request failed', action: 'Review the details below. Retry explicitly once the cause is resolved; your draft is preserved.', detail: text };
}
