// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

// DOCS_BLOCK_START:outputs-usage

import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/random/pet"
	random "github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/random/provider"
)

func NewOutputsUsageStack(scope constructs.Construct, name string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	random.NewRandomProvider(stack, jsii.String("random"), &random.RandomProviderConfig{})

	pet := pet.NewPet(stack, jsii.String("pet"), &pet.PetConfig{})
	cdktn.NewTerraformOutput(stack, jsii.String("random-pet"), &cdktn.TerraformOutputConfig{
		Value: pet.Id(),
	})

	return stack
}

// DOCS_BLOCK_END:outputs-usage

/*
We fake the methods name to be "main"
DOCS_BLOCK_START:outputs-usage
func main() {
DOCS_BLOCK_END:outputs-usage
*/
func SynthOutputsUsage() {
	// DOCS_BLOCK_START:outputs-usage
	app := cdktn.NewApp(nil)

	NewOutputsUsageStack(app, "outputs-usage")

	app.Synth()
}

// DOCS_BLOCK_END:outputs-usage
