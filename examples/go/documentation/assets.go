// Copyright (c) HashiCorp, Inc.
// SPDX-License-Identifier: MPL-2.0

// DOCS_BLOCK_START:assets
package main

import (
	"os"
	"path"

	"github.com/aws/constructs-go/constructs/v10"
	"github.com/aws/jsii-runtime-go"
	"github.com/open-constructs/cdk-terrain-go/cdktn"
	aws "github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/provider"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/s3bucket"
	"github.com/open-constructs/cdk-terrain/examples/go/documentation/generated/hashicorp/aws/s3bucketobject"
)

func NewAssetsStack(scope constructs.Construct, name string) cdktn.TerraformStack {
	stack := cdktn.NewTerraformStack(scope, &name)

	cwd, _ := os.Getwd()

	aws.NewAwsProvider(stack, jsii.String("aws"), &aws.AwsProviderConfig{
		Region: jsii.String("us-east-1"),
	})

	bucket := s3bucket.NewS3Bucket(stack, jsii.String("bucket"), &s3bucket.S3BucketConfig{
		Bucket: jsii.String("demo"),
	})

	asset := cdktn.NewTerraformAsset(stack, jsii.String("lambda-asset"), &cdktn.TerraformAssetConfig{
		Path: jsii.String(path.Join(cwd, "lambda")),
		Type: cdktn.AssetType_ARCHIVE,
	})

	s3bucketobject.NewS3BucketObject(stack, jsii.String("lambda-archive"), &s3bucketobject.S3BucketObjectConfig{
		Bucket: bucket.Bucket(),
		Key:    asset.FileName(),
		Source: asset.Path(),
	})

	return stack
}

// DOCS_BLOCK_END:assets

/*
We fake the methods name to be "main"
DOCS_BLOCK_START:assets
func main() {
DOCS_BLOCK_END:assets
*/
func SynthAssets() {
	// DOCS_BLOCK_START:assets
	app := cdktn.NewApp(nil)

	NewAssetsStack(app, "assets")

	app.Synth()
}

// DOCS_BLOCK_END:assets
