# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

# A module that expects its caller to hand it extra provider configurations,
# the way multi-region AWS modules do.

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.global_region, aws.secondary_region]
    }
  }
}

variable "bucket_name" {
  description = "Name of the s3 bucket. Must be unique."
  type        = string
}

output "arn" {
  description = "ARN of the bucket"
  value       = aws_s3_bucket.s3_bucket.arn
}
