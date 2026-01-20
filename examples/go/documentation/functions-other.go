// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
)

func NewFunctionsOtherStack(scope constructs.Construct, name string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	// DOCS_BLOCK_START:functions-lookup
	v := cdktn.NewTerraformVariable(stack, jsii.String("complex-object"), &cdktn.TerraformVariableConfig{
		Type: jsii.String("object({users: list(object({name: string}))})"),
	})
	cdktn.NewTerraformOutput(stack, jsii.String("users"), &cdktn.TerraformOutputConfig{
		Value: cdktn.Fn_Lookup(v.Value(), jsii.String("users"), nil),
	})
	cdktn.NewTerraformOutput(stack, jsii.String("first-user-name"), &cdktn.TerraformOutputConfig{
		Value: cdktn.Fn_LookupNested(v.Value(), &[]interface{}{"users", 0, "name"}),
	})
	// DOCS_BLOCK_END:functions-lookup

	// DOCS_BLOCK_START:functions-raw-string
	cdktn.NewTerraformOutput(stack, jsii.String("quotes"), &cdktn.TerraformOutputConfig{
		Value: cdktn.Fn_RawString(jsii.String("\"b\"")),
	})
	cdktn.NewTerraformOutput(stack, jsii.String("template"), &cdktn.TerraformOutputConfig{
		Value: cdktn.Fn_RawString(jsii.String("${TEMPLATE}")),
	})
	// DOCS_BLOCK_END:functions-raw-string

	return stack
}
