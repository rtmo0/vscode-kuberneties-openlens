# Kubernetes Explorer & OpenLens Tools

An independent, OpenLens-style Kubernetes IDE for VS Code: a cluster overview, every workload and resource in sortable tables, pods with live CPU and memory metrics, logs, shells, port forwarding, secrets, Helm releases, YAML editing, and safe import of kubeconfigs you receive as a file or as text.

No `kubectl` is needed: the extension talks to the API server directly with the credentials from your kubeconfig (certificates, tokens, exec plugins such as `aws`, `gke-gcloud-auth-plugin` or `yc`, and proxies).

> This community extension is not affiliated with, endorsed by, or sponsored by Mirantis, Inc. or the Lens / OpenLens projects. Lens is a trademark of Mirantis, Inc. Kubernetes is a registered trademark of The Linux Foundation.

## Features

### Get a cluster
- **Add Cluster** (the + in the Clusters view) and the **Get started with Kubernetes** walkthrough lead you through every way in:
  - **Local cluster** with kind, k3d or minikube: number of nodes, Kubernetes version, ports 80/443 for an ingress controller. Missing tools are installed with Homebrew; Docker is checked first. **Delete Local Cluster** removes the cluster and its context.
  - **Managed cluster**: lists your Yandex Managed Service for Kubernetes, Amazon EKS, Google GKE or Azure AKS clusters with `yc`, `aws`, `gcloud` or `az` and fetches the credentials (public or internal endpoint for Yandex Cloud).
  - **k3s on your servers over SSH**: installs a k3s server (and workers) with the version and ingress you choose, then imports a kubeconfig pointing at the right address.
- Every wizard imports through the same safe merge as kubeconfig import below.

### Set the cluster up
- **Add-ons**: metrics-server, ingress-nginx, cert-manager (with Let's Encrypt ClusterIssuers), Prometheus + Grafana, Loki + Promtail, Sealed Secrets, Argo CD, ExternalDNS and Local Path Provisioner — with values preset for local clusters, status detection (also for things installed some other way), **Edit Values & Install**, upgrade and uninstall.
- **Install Any Helm Chart**: search Artifact Hub, pick a version, edit the values with completion and validation from the chart's schema, then **Helm Install**. **Manage Helm Repositories** for the CLI.
- **Cluster Doctor**: API server certificate, Kubernetes version support, node health and version skew, capacity, metrics-server, DNS (with a live lookup test), default StorageClass, ingress controller, failing pods, containers without requests, blocking disruption budgets, Helm releases using removed APIs — with one-click fixes.

### Onboard people and apps
- **Onboard a Team**: namespace with quota, container defaults and optional network isolation, a service account bound to view / edit / admin, and a kubeconfig with a 30-day, 1-year or non-expiring token — to copy, save, or add to your own kubeconfig. Existing service accounts get a **Kubeconfig** action.
- **New Image Pull Secret** (Docker Hub, GHCR, GitLab, Yandex, Artifact Registry, Quay…, optionally attached to the namespace's default service account), **New TLS Secret From Files** (checks that the key matches and the certificate is valid), **Secret / ConfigMap From .env or Files**.
- **Deploy an Image**: a form for image, port, environment, secrets, resources, health checks, service type, ingress host with a cert-manager certificate and autoscaling, with a live YAML preview — deploy, or open the YAML in an editor.
- **Convert docker-compose to Kubernetes**: services, ports, environment, commands, named volumes (as PersistentVolumeClaims), health checks and resource limits become Deployments, Services and PVCs, with notes on what needs attention.

### Manifest IntelliSense from your cluster
- With the [YAML extension by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml), Kubernetes manifests are completed and validated against the OpenAPI schema of your cluster — built-in kinds and CRDs — including unknown fields (typos) and wrong apiVersions. Schemas are cached per cluster version and CRD set; **Refresh Manifest Schemas From Cluster** rebuilds them.

### Kubeconfig import that merges properly
- **Kubernetes: Import Kubeconfig…** from a file, from the clipboard, from the active editor, or by pasting into a new editor (YAML, JSON or base64).
- Contexts are merged into `~/.kube/config` (or the first file of `$KUBECONFIG` / the `openLens.kubeconfig` setting) without breaking what is already there:
  - clusters and users are matched by content, not just by name — installers all call them `kubernetes` and `kubernetes-admin`, so a different entry with a taken name is renamed (`kubernetes-admin-prod`) and the context points to it;
  - a context name that is taken asks whether to import under a new name, replace the existing context, or skip;
  - re-importing the same kubeconfig changes nothing;
  - relative certificate paths are resolved against the imported file's folder;
  - exec plugins, proxies and every other field are kept as they are.
- The file is validated before it is written, written atomically, keeps its permissions (0600 for new files) and symlink, and the previous version is kept as a timestamped backup (last 5).
- Switch, rename and remove contexts (unused clusters and users are cleaned up), and set a context's default namespace.

### Production safety
- Mark contexts as **protected** (`openLens.protectedContexts`, names or patterns like `*prod*`, or **Toggle Protected Context** in the tree): every change to them needs the context name typed to confirm, and their panels and status bar item turn red.
- Actions you have no RBAC permission for are hidden (checked with SelfSubjectAccessReview); without cluster-wide list rights, tables fall back to the context's namespace.

### Kubeconfig health, sync and export
- **Check Kubeconfig Health**: reachability, client certificate / CA / token expiry, missing certificate files, missing exec auth plugins — with a one-click cleanup of dead contexts. Expiring credentials are flagged in the tree.
- **Sync a Kubeconfig Folder**: every file in e.g. `~/.kube/configs` is loaded and watched.
- **Export Context**: a standalone kubeconfig for one context, with certificate files inlined — to the clipboard (YAML or base64), a file (mode 600) or an editor.

### Cluster overview
- Nodes ready, pod capacity, CPU and memory rings (usage, requests, limits against allocatable), usage charts over time.
- Workload health for pods, deployments, statefulsets, daemonsets, jobs and cronjobs.
- Recent warning events with links to the objects.
- Namespace filter per cluster, and a **Topology** view: ingress → service → pods, deployment → replica set → pods, statefulsets, daemonsets, cronjobs → jobs, and the config maps, secrets and volumes pods use.

### Resources
- Workloads, config, network, storage, access control, nodes, namespaces, events, Helm releases and custom resources (columns from the CRD's printer columns).
- **Live updates** through the Kubernetes watch API, with automatic re-list and reconnect.
- Search, sort, multi-select with bulk delete / restart / cordon, links between objects (owner, node, PVC, service…), row menus.
- Details panel: conditions, containers, volumes, labels, annotations, events, and kind-specific views; Back navigation between objects.
- **Go to Resource** (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>K</kbd> / <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>K</kbd>) searches every resource of a cluster; **Favorites** keeps pinned and recently opened resources.

### Pods, logs and metrics
- CPU and memory per pod, workload and node from metrics-server; with **Prometheus** (detected automatically or set per context) charts show hours to days of history and network traffic.
- **Log viewer**: several pods and containers at once, search with highlighting, "only matches", level filter, JSON log formatting, since 5 min … 24 h, previous instance, pause / resume, save to file. Logs can also open in a terminal (`openLens.logs.viewer`).
- **Shell** into a container with a real TTY (tries bash, then ash, then sh).
- **Debug container**: an ephemeral container (busybox, netshoot, alpine or any image) sharing the target container's processes, like `kubectl debug`.
- **Copy files** into and out of containers.

### Nodes
- Cordon / uncordon, **drain** (evictions respecting PodDisruptionBudgets, with progress and cancel), and a **root shell on the node** through a temporary privileged pod that is deleted afterwards.

### Rollouts and Helm
- **Rollout history** of deployments, statefulsets and daemonsets with a diff of each revision against the current one and **roll back**.
- Helm releases: values, notes, manifest and history; **diff values or manifests between revisions**, **roll back**, **edit values and upgrade** (with the chart stored in the release or one from a repository), uninstall. Changing releases needs the Helm CLI.

### Port forwarding
- Forward pod and service ports without kubectl; service forwards pick a ready pod per connection, so they survive restarts and rollouts.
- Port Forwards view with open in browser, copy URL and stop; status bar counter.

### Secrets and ConfigMaps
- Values decoded and masked until revealed; copy, edit, add, rename and delete keys in place. Binary values are detected.

### Editing and actions
- **Edit YAML** opens the live object in the editor; saving applies it, and a concurrent change on the server is reported instead of overwritten. **Diff With Live Object** compares your edits with the cluster.
- **Apply YAML to Cluster…** applies the manifest in the editor (multi-document, server-side apply) with a **dry-run preview** of the changes.
- **New Resource From Template** for deployments, services, ingresses, statefulsets, cronjobs, secrets, HPAs, network policies, RBAC and more.
- Scale, rollout restart, trigger cronjob, suspend / resume, delete.

### Copilot Chat tools
Read-only tools for Copilot Chat and other agents: `#k8s-list-contexts`, `#k8s-list-resources`, `#k8s-describe-resource`, `#k8s-pod-logs`, `#k8s-events`, `#k8s-cluster-overview`. Ask "why is the worker pod in apps crashing?" and the model gathers status, logs and events itself. Secret values are never returned.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `openLens.kubeconfig` | `[]` | Kubeconfig files to load, merged like `$KUBECONFIG`. Empty uses `$KUBECONFIG` or `~/.kube/config`. |
| `openLens.kubeconfigFolders` | `[]` | Folders whose files are all loaded as kubeconfigs. |
| `openLens.protectedContexts` | `[]` | Production contexts (names or `*` patterns) that need the context name typed to confirm changes. |
| `openLens.checkPermissions` | `true` | Hide actions you have no RBAC permission for. |
| `openLens.refreshInterval` | `5` | Seconds between refreshes of metrics and overview panels (tables update live). |
| `openLens.confirmDangerousOperations` | `true` | Confirm delete, restart, drain, rollback and scale to zero. |
| `openLens.backupKubeconfig` | `true` | Back up a kubeconfig file before changing it. |
| `openLens.logs.viewer` | `panel` | Open logs in the log viewer or in a terminal. |
| `openLens.logs.tailLines` | `500` | Past log lines to show (0 = all). |
| `openLens.logs.timestamps` | `false` | Prefix log lines with timestamps (terminal logs). |
| `openLens.shell` | `""` | Command for container shells; empty tries bash, ash, sh. |
| `openLens.debug.image` | `busybox:1.36` | Default image for debug containers. |
| `openLens.nodeShell.image` | `busybox:1.36` | Image of node shell pods (needs `nsenter`). |
| `openLens.nodeShell.namespace` | `kube-system` | Namespace of node shell pods. |
| `openLens.prometheus` | `{}` | Prometheus per context as `"context": "namespace/service:port"` or `"off"`; detected automatically otherwise. |
| `openLens.portForward.address` | `127.0.0.1` | Address port forwards listen on. |
| `openLens.portForward.openInBrowser` | `false` | Open new port forwards in the browser. |
| `openLens.tools` | `{}` | Paths of kind, k3d, minikube, helm, yc, aws, gcloud, az, ssh or docker when they are not on PATH. |
| `openLens.yamlSchemas.enabled` | `true` | Validate and complete manifests with the schema of your cluster. |
| `openLens.yamlSchemas.context` | `""` | Context whose schema validates workspace manifests; empty uses the current context. |

## Requirements

- VS Code 1.95 or newer.
- Metrics need [metrics-server](https://github.com/kubernetes-sigs/metrics-server) in the cluster; history beyond the open panel needs Prometheus with cAdvisor metrics.
- Helm upgrade, rollback and uninstall, add-ons and chart installs need the Helm CLI (offered for installation when missing); listing and inspecting releases does not.
- Local clusters need Docker (kind, k3d) and the tool itself; managed clusters need the provider CLI signed in; k3s needs SSH key access and sudo on the servers.
- Manifest completion needs the YAML extension by Red Hat.

## Development

```bash
npm install
npm run build      # or: npm run watch
npm test           # unit tests
OPENLENS_TEST_CONTEXT=kind-kind npm run test:integration   # against a cluster with test/integration/fixtures.yaml applied
```

CI runs the integration tests on a kind cluster with metrics-server, Helm and a minimal Prometheus.

Press <kbd>F5</kbd> to launch the Extension Development Host.

## License

[MIT](LICENSE)
