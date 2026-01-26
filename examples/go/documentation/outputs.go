// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

// DOCS_BLOCK_START:outputs

import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
)

type OutputsStackConfig struct {
	MyDomain string
}

func NewOutputsStack(scope constructs.Construct, name string, config OutputsStackConfig) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	cdktn.NewTerraformOutput(stack, jsii.String("my-domain"), &cdktn.TerraformOutputConfig{
		Value: &config.MyDomain,
	})

	return stack
}

// DOCS_BLOCK_END:outputs

/*
We fake the methods name to be "main"
DOCS_BLOCK_START:outputs
func main() {
DOCS_BLOCK_END:outputs
*/
func SynthOutputs() {
	// DOCS_BLOCK_START:outputs
	app := cdktn.NewApp(nil)

	NewOutputsStack(app, "outputs", OutputsStackConfig{
		MyDomain: "example.com",
	})

	app.Synth()
}

// DOCS_BLOCK_END:outputs
