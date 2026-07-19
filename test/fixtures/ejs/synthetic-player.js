/* SPDX-License-Identifier: MIT */
/* Project-generated EJS player fixture; contains no third-party player code. */
var marker = { alr() {} };
(function () {
	'use strict';
	const hex = (value) => {
		const bytes = [];
		for (let index = 0; index < value.length; index += 2) {
			bytes.push(Number.parseInt(value.slice(index, index + 2), 16));
		}
		return String.fromCharCode(...bytes);
	};
	const range = (end) => String.fromCharCode(...Array.from({ length: end + 1 }, (_, index) => index));
	const longSignature = 'NJAJEij0EwRgIhAI0KExTgjfPk-MPM9MAdzyyPRt=BM8-XO5tm5hlMCSVpAiEAv7eP3CURqZNSPow8BXXAoazVoXgeMP7gH9BdylHCwgw=gwzz';
	const profiles = {
		'74edf1a3': {
			n: new Map([
				['IlLiA21ny7gqA2m4p37', '9nRTxrbM1f0yHg'],
				['eabGFpsUKuWHXGh6FR4', 'izmYqDEY6kl7Sg'],
				['eabGF/ps%UK=uWHXGh6FR4', 'LACmqlhaBpiPlgE-a'],
			]),
			sig: new Map([
				[longSignature, 'NJAJEij0EwRgIhAI0KExTgjfPk-MPM9MAdzyyPRt=BM8-XO5tm5hzMCSVpAiEAv7eP3CURqZNSPow8BXXAoazVoXgeMP7gH9BdylHCwgw=gwzl'],
				[
					hex('000102250304050607080910111213141516171819202122232425262728293031323334353637383940414243444546474849'),
					hex('000102250304050607080910111213141516171819202122232425262728293031323334353637383940414249444546474843'),
				],
			]),
		},
		'901741ab': {
			n: new Map([['BQoJvGBkC2nj1ZZLK-', 'UMPovvBZRh-sjb']]),
			sig: new Map([[longSignature, 'wgwCHlydB9Hg7PMegXoVzaoAXXB8woPSNZqRUC3Pe7vAEiApVSCMlhwmt5ON-8MB=5RPyyzdAM9MPM-kPfjgTxEK0IAhIgRwE0jiEJA']]),
		},
		'e7573094': {
			n: new Map([['IlLiA21ny7gqA2m4p37', '3KuQ3235dojTSjo4']]),
			sig: new Map([[longSignature, 'yEij0EwRgIhAI0KExTgjfPk-MPM9MAdzyNPRt=BM8-XO5tm5hlMCSVNAiEAvpeP3CURqZJSPow8BXXAoazVoXgeMP7gH9BdylHCwgw=g']]),
		},
		'9fcf08e8': {
			n: new Map([['Dyc5ALyWiO0VqwCiT', 'H2PLmmAmJsYjKA']]),
			sig: new Map([[range(106), hex('6a696867666564636261605f5e5d5c5b5a595857565554535251504f4e4d4c4b4a494847464544434241403f3e3d3c3b3a393837363534333231302f2e2d2c2b2a292827262524232221201f1e1d1c1b1a191817161514131211100f0e0d0c0b030908070605040a')]]),
		},
		'21cd2156': {
			n: new Map([['CiOxDbW1WEE8Ti4w', 'ZcBE4klItiC4rQ']]),
			sig: new Map([[range(106), hex('030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434400464748494a4b6a4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768694c')]]),
		},
		'5e55da5a': {
			n: new Map([['FgTvzyq4jKv482R7', 'l26nyYSotkzDxg']]),
			sig: new Map([[range(106), hex('46666564636261605f5e676a5b5a595857565554535251504f4e4d4c4b4a4948472c4544434241403f3e3d3c3b3a393813363534333231302f2e2d5d2b2a292827262524232221201f1e1d1c1b1a1918171615140c1211100f0e0d000b0a09080706050403020137')]]),
		},
		'631d3938': {
			n: new Map([['KBx1qz7jMhxELa8c', 'ttPvh7WIptsgSw']]),
			sig: new Map([[range(102), hex('190102030405060708090a0b0c0d0e0f101112131415161718001a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60616263')]]),
		},
	};
	const profile = profiles["__PROFILE__"];
	class FixtureUrl {
		constructor(sig) { this.values = { s: sig }; }
		set(key, value) { this.values[key] = value; }
		get(key) { return this.values[key]; }
		clone() { return this; }
		transform() {
			const n = this.values.n;
			if (n != null) this.values.n = profile.n.get(n);
			const sig = this.values.s;
			if (sig != null) this.values.s = encodeURIComponent(profile.sig.get(decodeURIComponent(sig)));
		}
	}
	function solve(url, key, sig) {
		marker.alr('alr', 'yes');
		return new FixtureUrl(sig);
	}
})();
