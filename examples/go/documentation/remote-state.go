// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

// DOCS_BLOCK_START:remote-state

import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/random/pet"
	random "github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/random/provider"
)

func NewProducerStack(scope constructs.Construct, name string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	cdktn.NewCloudBackend(stack, &cdktn.CloudBackendConfig{
		Organization: jsii.String("hashicorp"),
		Workspaces:   cdktn.NewNamedCloudWorkspace(jsii.String("producer"), nil),
	})

	random.NewRandomProvider(stack, jsii.String("random"), &random.RandomProviderConfig{})

	pet := pet.NewPet(stack, jsii.String("pet"), &pet.PetConfig{})
	cdktn.NewTerraformOutput(stack, jsii.String("random-pet"), &cdktn.TerraformOutputConfig{
		Value: pet.Id(),
	})

	return stack
}

func NewConsumerStack(scope constructs.Construct, name string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	cdktn.NewCloudBackend(stack, &cdktn.CloudBackendConfig{
		Organization: jsii.String("hashicorp"),
		Workspaces:   cdktn.NewNamedCloudWorkspace(jsii.String("consumer"), nil),
	})

	remoteState := cdktn.NewDataTerraformRemoteState(stack, jsii.String("remote-pet"), &cdktn.DataTerraformRemoteStateRemoteConfig{
		Organization: jsii.String("hashicorp"),
		Workspaces:   cdktn.NewNamedCloudWorkspace(jsii.String("producer"), nil),
	})

	cdktn.NewTerraformOutput(stack, jsii.String("random-remote-pet"), &cdktn.TerraformOutputConfig{
		Value: remoteState.GetString(jsii.String("random-pet")),
	})

	return stack
}

// DOCS_BLOCK_END:remote-state

/*
We fake the methods name to be "main"
DOCS_BLOCK_START:remote-state
func main() {
DOCS_BLOCK_END:remote-state
*/
func SynthRemoteState() {
	// DOCS_BLOCK_START:remote-state
	app := cdktn.NewApp(nil)

	NewProducerStack(app, "cdktf-producer")
	NewConsumerStack(app, "cdktf-consumer")

	app.Synth()
}

// DOCS_BLOCK_END:remote-state
