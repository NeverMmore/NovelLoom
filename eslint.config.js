import globals from 'globals';

export default [
    {
        ignores: ['node_modules/**'],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.node, SillyTavern: 'readonly', toastr: 'readonly', jQuery: 'readonly' },
        },
        rules: {
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-dupe-keys': 'error',
            'no-redeclare': 'error',
            'no-const-assign': 'error',
        },
    },
];
