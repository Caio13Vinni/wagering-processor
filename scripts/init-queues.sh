#!/bin/sh

# Ceates the dead-letter queue (DLQ)
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

# 2. Create a redrive config
echo '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo","maxReceiveCount":"5"}' > /tmp/redrive.json

# Creates the main queue by associating the DLQ
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true,RedrivePolicy=file:///tmp/redrive.json

# remove temp archive
rm /tmp/redrive.json