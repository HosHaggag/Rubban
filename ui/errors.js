// Turns the raw errors of kubectl, the API server and the network into a title, a sentence a person
// can act on, and the next steps. Pure: no DOM. The raw message stays available as `detail`.

const host = message => message.match(/(?:dial tcp|Get "https?:\/\/|lookup) ?([\w.-]+(?::\d+)?)/)?.[1] || '';

export function explainError(error, { context = '' } = {}) {
  const detail = String(error?.message || error || '').trim();
  const status = error?.status;
  const where = context ? `“${context}”` : 'this cluster';
  const target = host(detail);
  if (error?.code === 'credentials' || /executable .* not found|gke-gcloud-auth-plugin|kubelogin|token (has )?expired|refresh token|Unauthorized|status code 401|You must be logged in|invalid_grant|reauth/i.test(detail))
    return { kind: 'auth', title: `Signed out of ${where}`, text: 'The cluster did not accept your credentials, or the sign-in plugin they need is missing or expired.', hints: ['Sign in again with your cloud CLI (Rubban offers the right command when it can tell which one).', 'Check that `kubectl get ns` works in a terminal with the same kubeconfig.'], detail };
  if (status === 403 || /forbidden/i.test(detail))
    return { kind: 'forbidden', title: 'You do not have permission for this', text: `Your identity may not read this in ${where}. Other views may still work.`, hints: ['Check my access lists exactly which permissions you have here.', 'Ask a cluster administrator for the missing permission, or switch to a namespace you can read.'], detail };
  if (/connection refused|no route to host|network is unreachable|host is down|EHOSTUNREACH|ECONNREFUSED/i.test(detail))
    return { kind: 'unreachable', title: `Can’t reach ${where}`, text: `The API server${target ? ` at ${target}` : ''} refused the connection or is not reachable from this computer.`, hints: ['Check that the cluster is running and that you are on the right network or VPN.', 'If the cluster moved, refresh your kubeconfig entry with your cloud CLI.'], detail };
  if (/no such host|server misbehaving|Temporary failure in name resolution|lookup .* on/i.test(detail))
    return { kind: 'dns', title: `Can’t find ${where}’s address`, text: `The name${target ? ` ${target.replace(/:\d+$/, '')}` : ' of the API server'} does not resolve from this computer.`, hints: ['Check your VPN or DNS settings; private clusters are often only visible on the company network.'], detail };
  if (/timeout|timed out|deadline exceeded|i\/o timeout|TLS handshake timeout|context canceled/i.test(detail))
    return { kind: 'timeout', title: `${context ? `“${context}”` : 'The cluster'} is not answering in time`, text: 'The request took too long. The API server may be overloaded, or the network path to it is slow or blocked.', hints: ['Try again in a moment.', 'If it keeps happening, check the VPN, proxy (HTTPS_PROXY) and firewall.'], detail };
  if (/x509|certificate|tls: /i.test(detail))
    return { kind: 'tls', title: 'The cluster’s certificate is not trusted', text: 'The API server’s TLS certificate does not match what your kubeconfig expects.', hints: ['Refresh the kubeconfig entry for this cluster; its certificate authority may have rotated.', 'A corporate proxy that inspects TLS can also cause this.'], detail };
  if (status === 404 || /the server could not find the requested resource|doesn't have a resource type|not found/i.test(detail))
    return { kind: 'notfound', title: 'Not found', text: 'This resource or kind does not exist in this cluster (any more).', hints: ['It may have been deleted, or the API it belongs to is not installed here.'], detail };
  if (/kubectl is not installed|executable file not found|"kubectl": executable/i.test(detail))
    return { kind: 'tool', title: 'kubectl is missing', text: 'Rubban needs kubectl to talk to clusters, and it could not find it.', hints: ['Install kubectl, or use a Rubban build that bundles it, then restart Rubban.'], detail };
  return { kind: 'other', title: 'Something went wrong', text: detail || 'The request failed.', hints: [], detail: '' };
}

// The errors that mean "the whole cluster is out of reach", as opposed to one view failing.
export const clusterDown = explained => ['auth', 'unreachable', 'dns', 'timeout', 'tls', 'tool'].includes(explained?.kind);
