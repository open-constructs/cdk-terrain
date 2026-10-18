const cdktn = require("cdktn");
cdktn.Testing.setupJest();
// Remove the temp dirs Testing.app() and Testing.fullSynth() create, after each test file
afterAll(() => cdktn.Testing.cleanup());
