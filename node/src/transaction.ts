/*
 * Copyright 2020 IBM All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { SubmittedTransaction, SubmittedTransactionImpl } from './submittedtransaction';
import util from 'util';
import { GatewayClient } from './client';
import { common, gateway } from './protos/protos';
import { SigningIdentity } from './signingidentity';
import { Signable } from './signable';

/**
 * Represents an endorsed transaction that can be submitted to the orderer for commit to the ledger.
 */
export interface Transaction extends Signable {
    /**
     * Get the transaction result. This is obtained during the endorsement process when the transaction proposal is
     * run on endorsing peers.
     */
    getResult(): Uint8Array;

    /**
     * Get the transaction ID.
     */
    getTransactionId(): string;

     /**
     * Submit the transaction to the orderer to be committed to the ledger.
     */
    submit(): Promise<SubmittedTransaction>;
}

export interface TransactionImplOptions {
    readonly client: GatewayClient;
    readonly signingIdentity: SigningIdentity;
    readonly channelName: string;
    readonly preparedTransaction: gateway.IPreparedTransaction;
}

export class TransactionImpl implements Transaction {
    readonly #client: GatewayClient;
    readonly #signingIdentity: SigningIdentity;
    readonly #channelName: string;
    readonly #preparedTransaction: gateway.IPreparedTransaction;
    readonly #envelope: common.IEnvelope;

    constructor(options: TransactionImplOptions) {
        this.#client = options.client;
        this.#signingIdentity = options.signingIdentity;
        this.#channelName = options.channelName;
        this.#preparedTransaction = options.preparedTransaction;

        const envelope = options.preparedTransaction.envelope;
        if (!envelope) {
            throw new Error(`Envelope not defined: ${util.inspect(options.preparedTransaction)}`);
        }
        this.#envelope = envelope;
    }

    getBytes(): Uint8Array {
        return gateway.PreparedTransaction.encode(this.#preparedTransaction).finish();
    }

    getDigest(): Uint8Array {
        const payload = this.#envelope.payload;
        if (!payload) {
            throw new Error(`Payload not defined: ${util.inspect(this.#envelope)}`);
        }
        return this.#signingIdentity.hash(payload);
    }

    getResult(): Uint8Array {
        return this.#preparedTransaction?.result?.payload || new Uint8Array(0);
    }

    getTransactionId(): string {
        const transactionId = this.#preparedTransaction.transaction_id;
        if (typeof transactionId !== 'string') {
            throw new Error(`Transaction ID not defined: ${util.inspect(this.#preparedTransaction)}`);
        }
        return transactionId;
    }

    async submit(): Promise<SubmittedTransaction> {
        await this.sign();
        await this.#client.submit(this.newSubmitRequest());

        return new SubmittedTransactionImpl({
            client: this.#client,
            signingIdentity: this.#signingIdentity,
            transactionId: this.getTransactionId(),
            signedRequest: this.newSignedCommitStatusRequest(),
            result: this.getResult(),
        })
    }

    setSignature(signature: Uint8Array): void {
        this.#envelope.signature = signature;
    }

    private async sign(): Promise<void> {
        if (this.isSigned()) {
            return;
        }

        const signature = await this.#signingIdentity.sign(this.getDigest());
        this.setSignature(signature);
    }

    private isSigned(): boolean {
        const signatureLength = this.#envelope.signature?.length ?? 0;
        return signatureLength > 0;
    }

    private newSubmitRequest(): gateway.ISubmitRequest {
        return {
            transaction_id: this.getTransactionId(),
            channel_id: this.#channelName,
            prepared_transaction: this.#envelope,
        };
    }

    private newSignedCommitStatusRequest(): gateway.ISignedCommitStatusRequest {
        return {
            request: gateway.CommitStatusRequest.encode(this.newCommitStatusRequest()).finish(),
        }
    }

    private newCommitStatusRequest(): gateway.ICommitStatusRequest {
        return {
            channel_id: this.#channelName,
            transaction_id: this.getTransactionId(),
            identity: this.#signingIdentity.getCreator(),
        }
    }
}
