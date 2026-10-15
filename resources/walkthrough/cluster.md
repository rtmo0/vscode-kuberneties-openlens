## Get a cluster

- **Import a kubeconfig** — from a file, the clipboard or pasted text. Contexts are merged into `~/.kube/config` with a backup; clashing names are renamed, never overwritten.
- **Local cluster** — `kind`, `k3d` or `minikube` in Docker. Pick the number of nodes, the Kubernetes version and whether ports 80/443 go to an ingress controller. Missing tools are installed with Homebrew.
- **Managed cluster** — lists your Yandex Managed Kubernetes, EKS, GKE or AKS clusters with the provider CLI and fetches the credentials.
- **k3s over SSH** — installs a k3s server (and workers) on your machines and imports the kubeconfig with the right address.
