// Partial list — only the codes confirmed in your diagnosis report.
// IMPORTANT: replace/extend this with the full contents of your supplied
// "nek-banks.js" file so every bank your users might select is covered.
export const NEK_BANKS = [
  { code: 'NGR057', name: 'Zenith Bank' },
  { code: 'NGR044', name: 'Access Bank' },
  { code: 'NGR050', name: 'Ecobank' },
  { code: 'NGR058', name: 'Guaranty Trust Bank' }
];

export function isValidBankCode(code) {
  return NEK_BANKS.some(b => b.code === code);
}
