// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
)

func NewMyStack(scope constructs.Construct, id string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &id)
	return stack
}

func main() {
	app := cdktn.Testing_StubVersion(cdktn.NewApp(&cdktn.AppConfig{StackTraces: jsii.Bool(false)}))

	NewMyStack(app, "go-simple")

	app.Synth()
}
