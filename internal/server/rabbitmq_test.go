package server

import (
	"encoding/base64"
	"reflect"
	"strings"
	"testing"
)

func rabbitTestPod(containers []any, labels obj, volumes []any) obj {
	return obj{"metadata": obj{"name": "mq-0", "labels": labels}, "spec": obj{"containers": containers, "volumes": volumes}}
}

func TestRabbitManagementPortsAreFoundByNumberOrName(t *testing.T) {
	svc := func(ports ...any) obj { return obj{"spec": obj{"ports": ports}} }
	cases := []struct {
		service obj
		want    *rabbitMgmtPort
	}{
		{svc(obj{"name": "amqp", "port": 5672.0}, obj{"name": "management", "port": 15672.0}), &rabbitMgmtPort{15672, "management", "http"}},
		{svc(obj{"name": "http-stats", "port": 8080.0, "targetPort": "stats"}), &rabbitMgmtPort{8080, "http-stats", "http"}},
		{svc(obj{"name": "web", "port": 80.0, "targetPort": "management"}), &rabbitMgmtPort{80, "web", "http"}},
		{svc(obj{"name": "management-tls", "port": 15671.0}), &rabbitMgmtPort{15671, "management-tls", "https"}},
		{svc(obj{"name": "amqp", "port": 5672.0}), nil},
	}
	for i, c := range cases {
		if got := rabbitManagementPort(c.service); !reflect.DeepEqual(got, c.want) {
			t.Errorf("case %d: %+v, want %+v", i, got, c.want)
		}
	}
}

func TestRabbitInitialLoginSources(t *testing.T) {
	operator := rabbitCredentialPlan(rabbitTestPod([]any{obj{"name": "rabbitmq", "image": "rabbitmq:3.13"}}, obj{"app.kubernetes.io/part-of": "rabbitmq", "app.kubernetes.io/name": "orders"}, nil))
	if operator.Kind != "Cluster Operator" || !reflect.DeepEqual(*operator.Password, rabbitSource{Type: "secret", Secret: "orders-default-user", Key: "password"}) {
		t.Fatalf("operator %+v", operator)
	}

	bitnami := rabbitCredentialPlan(rabbitTestPod([]any{obj{"name": "rabbitmq", "image": "docker.io/bitnami/rabbitmq:3.12", "env": []any{
		obj{"name": "RABBITMQ_USERNAME", "value": "app"},
		obj{"name": "RABBITMQ_PASSWORD", "valueFrom": obj{"secretKeyRef": obj{"name": "mq", "key": "rabbitmq-password"}}},
	}}}, obj{}, nil))
	if bitnami.Kind != "Bitnami" || !reflect.DeepEqual(*bitnami.Username, rabbitSource{Type: "literal", Via: "RABBITMQ_USERNAME"}) {
		t.Fatalf("bitnami %+v", bitnami)
	}
	if got := rabbitDescribeSource(bitnami.Password); got != "Secret mq › rabbitmq-password" {
		t.Fatalf("describe %q", got)
	}
	// Literal values are never part of the plan used for lists.
	if strings.Contains(strings.ReplaceAll(rabbitDescribeSource(bitnami.Username), "RABBITMQ_USERNAME", ""), "app") {
		t.Fatal("literal leaked into the description")
	}

	bitnamiDefaults := rabbitCredentialPlan(rabbitTestPod([]any{obj{"name": "rabbitmq", "image": "bitnami/rabbitmq:4.0", "env": []any{
		obj{"name": "RABBITMQ_PASSWORD", "valueFrom": obj{"secretKeyRef": obj{"name": "mq", "key": "rabbitmq-password"}}},
	}}}, obj{}, nil))
	if !reflect.DeepEqual(*bitnamiDefaults.Username, rabbitSource{Type: "default", Value: "user"}) {
		t.Fatalf("bitnami default user %+v", bitnamiDefaults.Username)
	}

	fileBased := rabbitCredentialPlan(rabbitTestPod([]any{obj{"name": "rabbitmq", "image": "bitnami/rabbitmq:4.0",
		"env":          []any{obj{"name": "RABBITMQ_PASSWORD_FILE", "value": "/opt/bitnami/rabbitmq/secrets/rabbitmq-password"}},
		"volumeMounts": []any{obj{"name": "creds", "mountPath": "/opt/bitnami/rabbitmq/secrets"}},
	}}, obj{}, []any{obj{"name": "creds", "secret": obj{"secretName": "mq-files"}}}))
	if !reflect.DeepEqual(*fileBased.Password, rabbitSource{Type: "secret", Secret: "mq-files", Key: "rabbitmq-password", Via: "RABBITMQ_PASSWORD_FILE"}) {
		t.Fatalf("file based %+v", fileBased.Password)
	}
	// items remap the file name to the Secret key.
	remapped := rabbitCredentialPlan(rabbitTestPod([]any{obj{"name": "rabbitmq", "image": "rabbitmq:4",
		"env":          []any{obj{"name": "RABBITMQ_DEFAULT_PASS_FILE", "value": "/secrets/pw"}},
		"volumeMounts": []any{obj{"name": "creds", "mountPath": "/secrets/"}},
	}}, obj{}, []any{obj{"name": "creds", "secret": obj{"secretName": "mq-files", "items": []any{obj{"key": "password", "path": "pw"}}}}}))
	if remapped.Password.Key != "password" || remapped.Password.Secret != "mq-files" {
		t.Fatalf("remapped %+v", remapped.Password)
	}
	// A literal with a variable substitution is not a value.
	substituted := rabbitCredentialPlan(rabbitTestPod([]any{obj{"name": "rabbitmq", "image": "rabbitmq:4", "env": []any{obj{"name": "RABBITMQ_DEFAULT_USER", "value": "$(USER)"}}}}, obj{}, nil))
	if substituted.Username.Type != "default" {
		t.Fatalf("substitution %+v", substituted.Username)
	}

	envFrom := rabbitCredentialPlan(rabbitTestPod([]any{obj{"name": "broker", "image": "rabbitmq:4.1-management", "envFrom": []any{obj{"secretRef": obj{"name": "broker-env"}, "prefix": ""}}}}, obj{}, nil))
	if envFrom.Password.Type != "secret-envfrom" || !reflect.DeepEqual(envFrom.Password.Alternatives, []string{"RABBITMQ_DEFAULT_PASS", "RABBITMQ_PASSWORD"}) || envFrom.Password.Fallback != "guest" {
		t.Fatalf("envFrom %+v", envFrom.Password)
	}

	plain := rabbitCredentialPlan(rabbitTestPod([]any{obj{"name": "broker", "image": "rabbitmq:4.1-management"}}, obj{}, nil))
	if !reflect.DeepEqual([]rabbitSource{*plain.Username, *plain.Password}, []rabbitSource{{Type: "default", Value: "guest"}, {Type: "default", Value: "guest"}}) {
		t.Fatalf("plain %+v %+v", plain.Username, plain.Password)
	}
	if got := rabbitDescribeSource(plain.Password); got != "RabbitMQ default (guest)" {
		t.Fatalf("describe %q", got)
	}
	if got := rabbitDescribeSource(&rabbitSource{Type: "default", Value: "user"}); got != "chart default (user)" {
		t.Fatalf("describe %q", got)
	}
	if rabbitCredentialPlan(nil).Kind != "RabbitMQ image" {
		t.Fatal("nil pod plan")
	}
}

func TestRabbitDiscoveryListsConsolesWithoutCredentialValues(t *testing.T) {
	services := obj{"items": []any{
		obj{"metadata": obj{"name": "orders", "namespace": "mq"}, "spec": obj{"selector": obj{"app": "orders"}, "ports": []any{obj{"name": "amqp", "port": 5672}, obj{"name": "management", "port": 15672}}}},
		obj{"metadata": obj{"name": "orders-headless", "namespace": "mq"}, "spec": obj{"clusterIP": "None", "selector": obj{"app": "orders"}, "ports": []any{obj{"name": "http-stats", "port": 15672}}}},
		obj{"metadata": obj{"name": "web", "namespace": "mq"}, "spec": obj{"selector": obj{"app": "web"}, "ports": []any{obj{"name": "management", "port": 15672}}}},
	}}
	mqPod := obj{"metadata": obj{"name": "orders-0", "namespace": "mq", "labels": obj{"app": "orders"}}, "spec": obj{"containers": []any{obj{"name": "rabbitmq", "image": "rabbitmq:3.13-management", "env": []any{
		obj{"name": "RABBITMQ_DEFAULT_USER", "value": "ops"},
		obj{"name": "RABBITMQ_DEFAULT_PASS", "valueFrom": obj{"secretKeyRef": obj{"name": "orders-login", "key": "pass"}}},
	}}}}, "status": obj{"phase": "Running", "conditions": []any{obj{"type": "Ready", "status": "True"}}}}
	webPod := obj{"metadata": obj{"name": "web-0", "namespace": "mq", "labels": obj{"app": "web"}}, "spec": obj{"containers": []any{obj{"name": "nginx", "image": "nginx:1.27"}}}, "status": obj{"phase": "Running"}}
	f := newFixture(t, func(args []string, _ RunOptions) Result {
		has := func(a string) bool {
			for _, x := range args {
				if x == a {
					return true
				}
			}
			return false
		}
		switch {
		case args[0] == "get" && args[1] == "services":
			return out(services, 0)
		case args[0] == "get" && args[1] == "pods":
			if has("--selector=app=web") {
				return out(obj{"items": []any{webPod}}, 0)
			}
			return out(obj{"items": []any{mqPod}}, 0)
		case has("secret") && has("orders-login"):
			return out(obj{"data": obj{"pass": base64.StdEncoding.EncodeToString([]byte("s3cret/+"))}}, 0)
		}
		return out(obj{"items": []any{}}, 0)
	})
	list := f.get("/api/rabbitmq?context=dev&namespace=*")
	if list.Status != 200 {
		t.Fatalf("list %d %v", list.Status, list.Value)
	}
	items := list.Value["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items %v", items)
	}
	item := items[0].(map[string]any)
	got := []any{item["id"], item["port"], item["kind"], item["login"].(map[string]any)["password"]}
	if !reflect.DeepEqual(got, []any{"mq/orders", 15672.0, "RabbitMQ image", "Secret orders-login › pass"}) {
		t.Fatalf("item %v", got)
	}
	if item["headless"] != false || item["scheme"] != "http" || item["version"] != "3.13-management" || item["amqpPort"] != 5672.0 || item["pod"] != "orders-0" ||
		!reflect.DeepEqual(item["pods"], map[string]any{"ready": 1.0, "total": 1.0}) {
		t.Fatalf("item fields %v", item)
	}
	for _, secret := range []string{"ops", "s3cret"} {
		if strings.Contains(string(list.Raw), secret) {
			t.Fatalf("list leaked %q: %s", secret, list.Raw)
		}
	}

	creds := f.post("/api/rabbitmq/credentials", map[string]any{"context": "dev", "namespace": "mq", "service": "orders"})
	if creds.Status != 200 || creds.Value["username"] != "ops" || creds.Value["password"] != "s3cret/+" {
		t.Fatalf("credentials %d %v", creds.Status, creds.Value)
	}
	if !reflect.DeepEqual(creds.Value["source"], map[string]any{"username": "RABBITMQ_DEFAULT_USER on the container", "password": "Secret orders-login › pass"}) {
		t.Fatalf("source %v", creds.Value["source"])
	}
	if r := f.post("/api/rabbitmq/credentials", map[string]any{"context": "dev", "namespace": "mq", "service": "web"}); r.Status != 404 {
		t.Fatalf("non-rabbit service %d", r.Status)
	}
	if r := f.post("/api/rabbitmq/credentials", map[string]any{"context": "dev", "namespace": "mq", "service": "-x"}); r.Status != 400 {
		t.Fatalf("bad service %d", r.Status)
	}
	if r := f.get("/api/rabbitmq?namespace=mq"); r.Status != 400 {
		t.Fatalf("missing context %d", r.Status)
	}
	if empty := newFixture(t, nil).get("/api/rabbitmq?context=dev"); empty.Status != 200 || string(empty.Raw) != `{"items":[]}` {
		t.Fatalf("empty %d %s", empty.Status, empty.Raw)
	}
}

func TestRabbitEnvFromFallsBackToDefaultWhenKeyIsMissing(t *testing.T) {
	services := obj{"items": []any{obj{"metadata": obj{"name": "mq", "namespace": "mq"}, "spec": obj{"selector": obj{"app": "mq"}, "ports": []any{obj{"name": "management", "port": 15672}}}}}}
	pod := obj{"metadata": obj{"name": "mq-0", "namespace": "mq"}, "spec": obj{"containers": []any{obj{"name": "broker", "image": "rabbitmq:4.1", "envFrom": []any{obj{"secretRef": obj{"name": "broker-env"}}}}}}, "status": obj{"phase": "Running"}}
	f := newFixture(t, func(args []string, _ RunOptions) Result {
		switch {
		case args[0] == "get" && args[1] == "services":
			return out(services, 0)
		case args[0] == "get" && args[1] == "pods":
			return out(obj{"items": []any{pod}}, 0)
		}
		return out(obj{"data": obj{"RABBITMQ_PASSWORD": base64.StdEncoding.EncodeToString([]byte("from-env"))}}, 0)
	})
	creds := f.post("/api/rabbitmq/credentials", map[string]any{"context": "dev", "namespace": "mq", "service": "mq"})
	if creds.Status != 200 || creds.Value["username"] != "guest" || creds.Value["password"] != "from-env" {
		t.Fatalf("credentials %d %v", creds.Status, creds.Value)
	}
}
