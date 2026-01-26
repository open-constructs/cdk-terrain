// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

import (
	"cdk.tf/go/stack/generated/hashicorp/random/pet"
	random "cdk.tf/go/stack/generated/hashicorp/random/provider"
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
)

func NewMyStack(scope constructs.Construct, id string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &id)
	cdktn.NewLocalBackend(stack, &cdktn.LocalBackendConfig{
		Path: jsii.String("terraform.tfstate"),
	})

	random.NewRandomProvider(stack, jsii.String("provider"), &random.RandomProviderConfig{})

	pet.NewPet(stack, jsii.String("pet"), &pet.PetConfig{Prefix: jsii.String("my")})

	return stack
}

func main() {
	app := cdktn.Testing_StubVersion(cdktn.NewApp(&cdktn.AppConfig{StackTraces: jsii.Bool(false)}))

	NewMyStack(app, "go-simple")

	app.Synth()
}
