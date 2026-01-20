// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

package main

// DOCS_BLOCK_START:tokens
import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/terraform-aws-modules/aws/eks"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/terraform-aws-modules/aws/vpc"
)

func NewTokensStack(scope constructs.Construct, name string, vpcName string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	logRetention := cdktn.NewTerraformVariable(stack, jsii.String("logRetentionInDays"), &cdktn.TerraformVariableConfig{
		Type: jsii.String("number"),
	})

	vpc := vpc.NewVpc(stack, &vpcName, &vpc.VpcConfig{
		Name:          &vpcName,
		PublicSubnets: &[]*string{jsii.String("10.0.1.0/24"), jsii.String("10.0.2.0/24")},
	})

	eks.NewEks(stack, jsii.String("EksModule"), &eks.EksConfig{
		ClusterName:                       jsii.String("my-kubernetes-cluster"),
		SubnetIds:                         cdktn.Token_AsList(vpc.PublicSubnetsOutput(), nil),
		CloudwatchLogGroupRetentionInDays: logRetention.NumberValue(),
	})

	return stack
}

// DOCS_BLOCK_END:tokens
