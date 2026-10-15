## Cluster Doctor

Checks, with fixes where possible:

- API server certificate expiry and Kubernetes version support
- Node readiness, pressure, kubelet version skew, schedulable capacity
- metrics-server, DNS (with a live lookup test), default StorageClass, ingress controller
- Failing and stuck pods, containers without resource requests, blocking PodDisruptionBudgets
- Helm releases that use API versions removed in this or the next Kubernetes versions
