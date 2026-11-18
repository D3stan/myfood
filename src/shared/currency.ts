/** ISO 4217 codes the household can pick. */
export const CURRENCIES = ['DKK', 'SEK', 'NOK', 'EUR', 'GBP', 'USD', 'CHF', 'PLN', 'CZK', 'ISK', 'JPY', 'CAD', 'AUD'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = 'DKK';
