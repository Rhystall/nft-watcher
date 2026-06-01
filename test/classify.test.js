const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ZERO_ADDRESS,
    classifyTransaction,
    buildEventFromTransaction
} = require('../index');

const TRACKED = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const BUYER_PAYMENT_TARGET = '0x3333333333333333333333333333333333333333';
const CONTRACT = '0x4444444444444444444444444444444444444444';
const trackedWallets = new Set([TRACKED]);

function nft(overrides = {}) {
    return {
        kind: 'nft',
        hash: '0xtx',
        transactionHash: '0xtx',
        category: 'erc721',
        tokenType: 'erc721',
        contractAddress: CONTRACT,
        tokenId: '1',
        tokenIds: ['1'],
        fromAddress: OTHER,
        toAddress: TRACKED,
        ...overrides
    };
}

function payment(overrides = {}) {
    return {
        kind: 'payment',
        hash: '0xtx',
        transactionHash: '0xtx',
        category: 'external',
        tokenType: null,
        asset: 'ETH',
        amount: '1.2',
        fromAddress: TRACKED,
        toAddress: BUYER_PAYMENT_TARGET,
        ...overrides
    };
}

test('incoming NFT without payment is classified as transfer', () => {
    const classification = classifyTransaction([nft()], trackedWallets, []);

    assert.equal(classification.eventType, 'TRANSFER');
    assert.equal(classification.rawEventType, 'INCOMING_NO_PAYMENT');
    assert.equal(classification.paymentEvidence.length, 0);
});

test('incoming NFT with tracked payment out is classified as buy', () => {
    const classification = classifyTransaction([nft()], trackedWallets, [payment()]);

    assert.equal(classification.eventType, 'BUY');
    assert.equal(classification.rawEventType, 'BUY');
    assert.equal(classification.paymentEvidence.length, 1);

    const event = buildEventFromTransaction('0xtx', [nft()], classification, trackedWallets);
    assert.equal(event.type, 'buy');
    assert.equal(event.paymentEvidence[0].asset, 'ETH');
});

test('incoming NFT with zero-value payment is still classified as transfer', () => {
    const classification = classifyTransaction([nft()], trackedWallets, [payment({ amount: '0' })]);

    assert.equal(classification.eventType, 'TRANSFER');
    assert.equal(classification.rawEventType, 'INCOMING_NO_PAYMENT');
});

test('multi-NFT incoming with tracked payment out is classified as sweep buy', () => {
    const nftActivities = [
        nft({ tokenId: '10', tokenIds: ['10'] }),
        nft({ tokenId: '11', tokenIds: ['11'] }),
        nft({ tokenId: '12', tokenIds: ['12'] })
    ];
    const classification = classifyTransaction(nftActivities, trackedWallets, [payment()]);

    assert.equal(classification.eventType, 'SWEEP_BUY');
    assert.equal(classification.rawEventType, 'SWEEP_BUY');
    assert.equal(classification.nftCount, 3);
    assert.equal(classification.isSweep, true);
});

test('outgoing NFT with tracked payment in is classified as sell', () => {
    const classification = classifyTransaction(
        [nft({ fromAddress: TRACKED, toAddress: OTHER })],
        trackedWallets,
        [payment({ fromAddress: OTHER, toAddress: TRACKED })]
    );

    assert.equal(classification.eventType, 'SELL');
    assert.equal(classification.rawEventType, 'SELL');
    assert.equal(classification.paymentEvidence.length, 1);
});

test('multi-NFT outgoing with tracked payment in is classified as bulk sell', () => {
    const nftActivities = [
        nft({ tokenId: '21', tokenIds: ['21'], fromAddress: TRACKED, toAddress: OTHER }),
        nft({ tokenId: '22', tokenIds: ['22'], fromAddress: TRACKED, toAddress: OTHER })
    ];
    const classification = classifyTransaction(
        nftActivities,
        trackedWallets,
        [payment({ fromAddress: OTHER, toAddress: TRACKED })]
    );

    assert.equal(classification.eventType, 'SELL');
    assert.equal(classification.rawEventType, 'BULK_SELL');
    assert.equal(classification.nftCount, 2);
});

test('mint from zero address remains mint', () => {
    const classification = classifyTransaction(
        [nft({ fromAddress: ZERO_ADDRESS, toAddress: TRACKED })],
        trackedWallets,
        []
    );

    assert.equal(classification.eventType, 'MINT');
    assert.equal(classification.rawEventType, 'MINT');
});

test('tracked-to-tracked NFT movement is classified as internal transfer', () => {
    const secondTracked = '0x5555555555555555555555555555555555555555';
    const classification = classifyTransaction(
        [nft({ fromAddress: TRACKED, toAddress: secondTracked })],
        new Set([TRACKED, secondTracked]),
        [payment()]
    );

    assert.equal(classification.eventType, 'TRANSFER');
    assert.equal(classification.rawEventType, 'INTERNAL_TRANSFER');
});
