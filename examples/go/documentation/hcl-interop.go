// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

// DOCS_BLOCK_START:hcl-interop
import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/random/pet"
	random "github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/random/provider"
)

func NewHclInteropStack(scope constructs.Construct, name string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	random.NewRandomProvider(stack, jsii.String("default"), &random.RandomProviderConfig{})

	petNameLength := cdktn.NewTerraformVariable(stack, jsii.String("petNameLength"), &cdktn.TerraformVariableConfig{
		Type:        jsii.String("number"),
		Default:     jsii.Number(2),
		Description: jsii.String("Pet name length"),
	})

	myPet := pet.NewPet(stack, jsii.String("example"), &pet.PetConfig{
		Length: petNameLength.NumberValue(),
	})

	cdktn.NewTerraformOutput(stack, jsii.String("name"), &cdktn.TerraformOutputConfig{
		Value: myPet.Id(),
	})

	return stack
}

// DOCS_BLOCK_END:hcl-interop
