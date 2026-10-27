// Starter manifests for the Create dialog. Each template is plain YAML with the target
// namespace filled in; nothing is applied until the user previews and confirms.
const T = (kind, group, build) => ({ kind, group, build });
export const TEMPLATES = [
  T('Pod', 'Workloads', ns => `apiVersion: v1
kind: Pod
metadata:
  name: example-pod
  namespace: ${ns}
  labels:
    app: example
spec:
  containers:
    - name: app
      image: nginx:1.27
      ports:
        - containerPort: 80
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          memory: 128Mi
`),
  T('Deployment', 'Workloads', ns => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
  namespace: ${ns}
  labels:
    app: example
spec:
  replicas: 2
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: app
          image: nginx:1.27
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: 80
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              memory: 256Mi
`),
  T('StatefulSet', 'Workloads', ns => `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: example
  namespace: ${ns}
spec:
  serviceName: example
  replicas: 1
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      containers:
        - name: app
          image: nginx:1.27
          volumeMounts:
            - name: data
              mountPath: /usr/share/nginx/html
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 1Gi
`),
  T('DaemonSet', 'Workloads', ns => `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: example
  namespace: ${ns}
spec:
  selector:
    matchLabels:
      app: example
  template:
    metadata:
      labels:
        app: example
    spec:
      tolerations:
        - operator: Exists
      containers:
        - name: agent
          image: busybox:1.36
          command: [sh, -c, 'while true; do sleep 3600; done']
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
`),
  T('ReplicaSet', 'Workloads', ns => `apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: example
  namespace: ${ns}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: example-rs
  template:
    metadata:
      labels:
        app: example-rs
    spec:
      containers:
        - name: app
          image: nginx:1.27
`),
  T('Job', 'Workloads', ns => `apiVersion: batch/v1
kind: Job
metadata:
  name: example-job
  namespace: ${ns}
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: job
          image: busybox:1.36
          command: [sh, -c, 'echo hello from Rubban && sleep 5']
`),
  T('CronJob', 'Workloads', ns => `apiVersion: batch/v1
kind: CronJob
metadata:
  name: example-cron
  namespace: ${ns}
spec:
  schedule: "*/15 * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: job
              image: busybox:1.36
              command: [sh, -c, date]
`),
  T('ConfigMap', 'Config', ns => `apiVersion: v1
kind: ConfigMap
metadata:
  name: example-config
  namespace: ${ns}
data:
  key: value
  app.properties: |
    mode=production
`),
  T('Secret', 'Config', ns => `apiVersion: v1
kind: Secret
metadata:
  name: example-secret
  namespace: ${ns}
type: Opaque
stringData:
  username: admin
  password: change-me
`),
  T('ResourceQuota', 'Config', ns => `apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute
  namespace: ${ns}
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    pods: "50"
`),
  T('LimitRange', 'Config', ns => `apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
  namespace: ${ns}
spec:
  limits:
    - type: Container
      defaultRequest:
        cpu: 100m
        memory: 128Mi
      default:
        cpu: 500m
        memory: 512Mi
      max:
        cpu: "2"
        memory: 2Gi
`),
  T('HorizontalPodAutoscaler', 'Config', ns => `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: example
  namespace: ${ns}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: example
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
`),
  T('VerticalPodAutoscaler', 'Config', ns => `apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: example
  namespace: ${ns}
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: example
  updatePolicy:
    updateMode: "Off"
`),
  T('PodDisruptionBudget', 'Config', ns => `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: example
  namespace: ${ns}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: example
`),
  T('PriorityClass', 'Config', () => `apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: example-high
value: 100000
globalDefault: false
description: Workloads that should be scheduled before batch jobs.
`),
  T('RuntimeClass', 'Config', () => `apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: example
handler: runc
`),
  T('Lease', 'Config', ns => `apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: example-lock
  namespace: ${ns}
spec:
  holderIdentity: example
  leaseDurationSeconds: 15
`),
  T('Service', 'Network', ns => `apiVersion: v1
kind: Service
metadata:
  name: example
  namespace: ${ns}
spec:
  type: ClusterIP
  selector:
    app: example
  ports:
    - name: http
      port: 80
      targetPort: 80
`),
  T('Ingress', 'Network', ns => `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: example
  namespace: ${ns}
spec:
  rules:
    - host: example.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: example
                port:
                  number: 80
`),
  T('IngressClass', 'Network', () => `apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: example
spec:
  controller: example.com/ingress-controller
`),
  T('NetworkPolicy', 'Network', ns => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-same-namespace
  namespace: ${ns}
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: {}
`),
  T('Endpoints', 'Network', ns => `apiVersion: v1
kind: Endpoints
metadata:
  name: external-service
  namespace: ${ns}
subsets:
  - addresses:
      - ip: 192.0.2.10
    ports:
      - port: 443
`),
  T('PersistentVolumeClaim', 'Storage', ns => `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: example-data
  namespace: ${ns}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi
`),
  T('PersistentVolume', 'Storage', () => `apiVersion: v1
kind: PersistentVolume
metadata:
  name: example-pv
spec:
  capacity:
    storage: 5Gi
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  hostPath:
    path: /mnt/data
`),
  T('StorageClass', 'Storage', () => `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: example
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
`),
  T('Namespace', 'Cluster', () => `apiVersion: v1
kind: Namespace
metadata:
  name: example
`),
  T('ServiceAccount', 'Access Control', ns => `apiVersion: v1
kind: ServiceAccount
metadata:
  name: example
  namespace: ${ns}
`),
  T('Role', 'Access Control', ns => `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: ${ns}
rules:
  - apiGroups: [""]
    resources: [pods, pods/log]
    verbs: [get, list, watch]
`),
  T('ClusterRole', 'Access Control', () => `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: example-reader
rules:
  - apiGroups: [""]
    resources: [namespaces, nodes]
    verbs: [get, list, watch]
`),
  T('RoleBinding', 'Access Control', ns => `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: ${ns}
subjects:
  - kind: ServiceAccount
    name: example
    namespace: ${ns}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: pod-reader
`),
  T('ClusterRoleBinding', 'Access Control', ns => `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: example-reader
subjects:
  - kind: ServiceAccount
    name: example
    namespace: ${ns}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: example-reader
`),
  T('ValidatingWebhookConfiguration', 'Config', ns => `apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: example
webhooks:
  - name: validate.example.com
    admissionReviewVersions: [v1]
    sideEffects: None
    failurePolicy: Ignore
    clientConfig:
      service:
        name: example-webhook
        namespace: ${ns}
        path: /validate
    rules:
      - operations: [CREATE, UPDATE]
        apiGroups: [apps]
        apiVersions: [v1]
        resources: [deployments]
`),
  T('MutatingWebhookConfiguration', 'Config', ns => `apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: example
webhooks:
  - name: mutate.example.com
    admissionReviewVersions: [v1]
    sideEffects: None
    failurePolicy: Ignore
    clientConfig:
      service:
        name: example-webhook
        namespace: ${ns}
        path: /mutate
    rules:
      - operations: [CREATE]
        apiGroups: [""]
        apiVersions: [v1]
        resources: [pods]
`),
  T('CustomResourceDefinition', 'Custom Resources', () => `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.example.com
spec:
  group: example.com
  scope: Namespaced
  names:
    plural: widgets
    singular: widget
    kind: Widget
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                size:
                  type: integer
      additionalPrinterColumns:
        - name: Size
          type: integer
          jsonPath: .spec.size
`),
];
// Template matching a resource view ("deployments", "services", …), if any.
export function templateFor(resource) {
  const plural = String(resource || '').split('.')[0];
  return TEMPLATES.find(t => `${t.kind.toLowerCase()}s` === plural || `${t.kind.toLowerCase()}es` === plural || (t.kind === 'Endpoints' && plural === 'endpoints') || (t.kind.endsWith('y') && `${t.kind.toLowerCase().slice(0, -1)}ies` === plural) || (t.kind === 'Ingress' && plural === 'ingresses')) || null;
}
