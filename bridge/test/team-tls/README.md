This public certificate and private key are synthetic offline test fixtures, not credentials.
They terminate `api.anthropic.com` CONNECT requests inside a local deny-by-default proxy.
The certificate is trusted only in disposable native test child environments via
`NODE_EXTRA_CA_CERTS`; it is never installed in the operating system or user profile.
The proxy never connects to the internet.
