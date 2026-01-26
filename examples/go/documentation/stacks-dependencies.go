// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

// DOCS_BLOCK_START:stack-dependencies

import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/instance"
	aws "github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/provider"
)

type SourceStack struct {
	Instance instance.Instance
}

func NewSourceStack(scope constructs.Construct, name string) SourceStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	aws.NewAwsProvider(stack, jsii.String("aws"), &aws.AwsProviderConfig{
		Region: jsii.String("us-east-1"),
	})

	instance := instance.NewInstance(stack, jsii.String("Hello"), &instance.InstanceConfig{
		Ami:          jsii.String("ami-abcde123"),
		InstanceType: jsii.String("t2.micro"),
	})

	return SourceStack{
		Instance: instance,
	}
}

type DependencyStack struct {
	AllResources *[]*string
}

func NewDependencyStack(scope constructs.Construct, name string, dependencies []*SourceStack) DependencyStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	ids := make([]*string, 0)
	for _, dep := range dependencies {
		ids = append(ids, dep.Instance.Id())
	}

	allResources := cdktn.NewTerraformLocal(stack, jsii.String("merged_items"), ids)

	return DependencyStack{
		AllResources: allResources.AsList(),
	}
}

func NewNestedDependencyStack(scope constructs.Construct, name string, allResources []*string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	cdktn.NewTerraformOutput(stack, jsii.String("all_resources"), &cdktn.TerraformOutputConfig{
		Value: allResources,
	})

	return stack
}

// DOCS_BLOCK_END:stack-dependencies

/*
We fake the methods name to be "main"
DOCS_BLOCK_START:stack-dependencies
func main() {
DOCS_BLOCK_END:stack-dependencies
*/
func SynthStackDependencies() {
	// DOCS_BLOCK_START:stack-dependencies
	app := cdktn.NewApp(nil)

	stackA := NewSourceStack(app, "stack-a")
	stackB := NewSourceStack(app, "stack-b")

	stackC := NewDependencyStack(app, "stack-c", []*SourceStack{&stackA, &stackB})

	NewNestedDependencyStack(app, "stack-d", *stackC.AllResources)

	app.Synth()
}

// DOCS_BLOCK_END:stack-dependencies
