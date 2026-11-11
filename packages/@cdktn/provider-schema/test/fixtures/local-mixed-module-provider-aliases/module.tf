# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

# One half of a module that spreads its terraform settings across .tf and
# .tf.json files. Terraform allows several terraform blocks but only one
# required_providers configuration, so the provider requirements live in the
# .tf.json half - which hcl2json merges into a shape that hides them from a
# plain walk over the parsed terraform blocks.

terraform {
  required_version = ">= 1.0"
}

variable "bucket_name" {
  description = "Name of the s3 bucket. Must be unique."
  type        = string
}

output "arn" {
  description = "ARN of the bucket"
  value       = aws_s3_bucket.s3_bucket.arn
}
