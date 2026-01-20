// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

// DOCS_BLOCK_START:functions
import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/dataawsavailabilityzones"
	aws "github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/provider"
)

func NewFunctionsStack(scope constructs.Construct, name string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	aws.NewAwsProvider(stack, jsii.String("aws"), &aws.AwsProviderConfig{
		Region: jsii.String("use-west-2"),
	})

	zones := dataawsavailabilityzones.NewDataAwsAvailabilityZones(stack, jsii.String("zones"), &dataawsavailabilityzones.DataAwsAvailabilityZonesConfig{
		State: jsii.String("available"),
	})

	cdktn.NewTerraformOutput(stack, jsii.String("first-zone"), &cdktn.TerraformOutputConfig{
		Value: cdktn.Fn_Element(cdktn.Token_AsAny(zones.Names()), jsii.Number(0)),
	})

	return stack
}

// DOCS_BLOCK_END:functions
