// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

// DOCS_BLOCK_START:constructs-scope
package main

import (
	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	aws "github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/provider"
	s3bucket "github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/s3bucket"
)

type PublicS3Bucket struct {
	Bucket *s3bucket.S3Bucket
}

func NewPublicS3Bucket(scope constructs.Construct, name *string) *PublicS3Bucket {
	c := constructs.NewConstruct(scope, name)

	bucket := s3bucket.NewS3Bucket(c, name, &s3bucket.S3BucketConfig{
		BucketPrefix: name,
		Website: &s3bucket.S3BucketWebsite{
			IndexDocument: jsii.String("index.html"),
			ErrorDocument: jsii.String("5xx.html"),
		},
	})

	return &PublicS3Bucket{
		Bucket: &bucket,
	}
}

func NewConstructsScopingStack(scope constructs.Construct, name string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	aws.NewAwsProvider(stack, jsii.String("aws"), &aws.AwsProviderConfig{
		Region: jsii.String("us-east-1"),
	})
	NewPublicS3Bucket(stack, jsii.String("first-bucket"))
	NewPublicS3Bucket(stack, jsii.String("second-bucket"))

	return stack
}

// DOCS_BLOCK_END:constructs-scope

/*
We fake the methods name to be "main"
DOCS_BLOCK_START:constructs-scope
func main() {
DOCS_BLOCK_END:constructs-scope
*/
func SynthConstructsScope() {
	// DOCS_BLOCK_START:constructs-scope
	app := cdktn.NewApp(nil)

	NewConstructsScopingStack(app, "constructs-scope")

	app.Synth()
}

// DOCS_BLOCK_END:constructs-scope
