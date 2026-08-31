// Stands in for the OS keychain command a real deployment names. It prints a
// placeholder so no test, fixture or CI run ever handles a real credential.
process.stdout.write("pix-test-placeholder-not-a-credential\n");
