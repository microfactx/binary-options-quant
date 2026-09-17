"use strict";

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

describe('Model Registry Governance: MODEL_H010 Manifest Audit', () => {
  const manifestPath = path.join(__dirname, '..', '..', 'artifacts', 'model_registry', 'MODEL_H010_MANIFEST.json');

  test('manifest file exists and parses as valid JSON', () => {
    expect(fs.existsSync(manifestPath)).toBe(true);
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.modelId).toBe('MODEL_H010_BTCUSDT_ORDERFLOW_ABSORPTION');
    expect(parsed.state).toBe('03_APPROVED_CANDIDATE');
  });

  test('verifies implementation source code SHA-256 integrity', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const entrypointPath = path.join(__dirname, '..', '..', manifest.implementation.entrypoint);
    expect(fs.existsSync(entrypointPath)).toBe(true);

    const content = fs.readFileSync(entrypointPath, 'utf-8');
    const actualHash = crypto.createHash('sha256').update(content).digest('hex');
    expect(actualHash).toBe(manifest.implementation.sourceCodeSha256);
  });

  test('verifies frozen hypothesis spec SHA-256 integrity', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const specPath = path.join(__dirname, '..', '..', 'research', 'governance', `${manifest.hypothesis.hypothesisId}.json`);
    expect(fs.existsSync(specPath)).toBe(true);

    const content = fs.readFileSync(specPath, 'utf-8');
    const actualHash = crypto.createHash('sha256').update(content).digest('hex');
    expect(actualHash).toBe(manifest.hypothesis.specSha256);
  });

  test('verifies 4-way governance consensus quorum (CRO, CTO, Controller, CEO)', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const sigs = manifest.governanceConsensusSignatures;

    expect(sigs.chiefRiskOfficer.verdict).toBe('APPROVED');
    expect(sigs.chiefTechnologyOfficer.verdict).toBe('APPROVED');
    expect(sigs.experimentController.verdict).toBe('VERIFIED');
    expect(sigs.chiefExecutiveOfficer.verdict).toBe('MANDATE_AUTHORIZED');
  });

  test('enforces Constitutional Invariant 4: W_low > P_BE', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const { wilsonLowerBound95, surplusBasisPoints } = manifest.validationSummary;
    const breakevenHurdle = manifest.instrument.breakevenHurdle;

    expect(wilsonLowerBound95).toBeGreaterThan(breakevenHurdle);
    expect(surplusBasisPoints).toBeGreaterThan(0);
    expect(surplusBasisPoints).toBeCloseTo((wilsonLowerBound95 - breakevenHurdle) * 10000, 1);
  });

  test('verifies 100% monthly consistency across all 5 OOS months', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifest.validationSummary.monthlyConsistency).toBe('5_OF_5_MONTHS_PROFITABLE');
    expect(manifest.validationSummary.realizedWinRate).toBeGreaterThan(0.60);
    expect(manifest.validationSummary.alphaOverReversedPp).toBeGreaterThan(20.0);
  });
});
