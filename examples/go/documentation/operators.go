// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

// DOCS_BLOCK_START:operators,functions-raw
import (
	"fmt"

	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/dataawsavailabilityzones"
	aws "github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/provider"
)

// DOCS_BLOCK_END:operators,functions-raw

func NewOperatorsAndFunctionsRawStack(scope constructs.Construct, name string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	aws.NewAwsProvider(stack, jsii.String("aws"), &aws.AwsProviderConfig{
		Region: jsii.String("use-west-2"),
	})
	// DOCS_BLOCK_START:operators,functions-raw
	zones := dataawsavailabilityzones.NewDataAwsAvailabilityZones(stack, jsii.String("zones"),
		&dataawsavailabilityzones.DataAwsAvailabilityZonesConfig{
			State: jsii.String("available"),
		},
	)

	// DOCS_BLOCK_END:functions-raw
	cdktn.NewTerraformOutput(stack, jsii.String("half-of-the-zone"), &cdktn.TerraformOutputConfig{
		Value: cdktn.Op_Div(
			cdktn.Fn_LengthOf(cdktn.Token_AsAny(zones.Names())),
			jsii.Number(2),
		),
	})
	// DOCS_BLOCK_END:operators

	// DOCS_BLOCK_START:functions-raw
	cdktn.NewTerraformOutput(stack, jsii.String("half-of-the-zone-raw"), &cdktn.TerraformOutputConfig{
		Value: jsii.String(
			fmt.Sprintf("${length(%s.names) / 2}",
				*cdktn.Token_AsString(zones.Names(), &cdktn.EncodingOptions{}),
			),
		),
	})
	// DOCS_BLOCK_END:functions-raw

	return stack
}
