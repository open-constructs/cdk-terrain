// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

// DOCS_BLOCK_START:constructs
package main

import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	kubernetes "github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/kubernetes/provider"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/myconstructs"

	"os"
	"path"
)

func NewConstructsStack(scope constructs.Construct, name string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	cwd, _ := os.Getwd()

	kubernetes.NewKubernetesProvider(stack, jsii.String("kind"), &kubernetes.KubernetesProviderConfig{
		ConfigPath: jsii.String(path.Join(cwd, "kubeconfig.yaml")),
	})
	myconstructs.NewKubernetesWebAppDeployment(stack, "deployment", map[string]interface{}{
		"image":       jsii.String("nginx:latest"),
		"replicas":    jsii.Number(2),
		"app":         jsii.String("myapp"),
		"component":   jsii.String("frontend"),
		"environment": jsii.String("dev"),
	})

	return stack
}

// DOCS_BLOCK_END:constructs

/*
We fake the methods name to be "main"
DOCS_BLOCK_START:constructs
func main() {
DOCS_BLOCK_END:constructs
*/
func SynthConstructs() {
	// DOCS_BLOCK_START:constructs
	app := cdktn.NewApp(nil)

	NewConstructsStack(app, "constructs")

	app.Synth()
}

// DOCS_BLOCK_END:constructs
