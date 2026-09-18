// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * What can the deployer still do to this token after you buy it?
 *
 * ## Why this replaces a DELEGATECALL scan
 *
 * The first version flagged any bytecode containing DELEGATECALL as possibly
 * upgradeable. On Arc that fires on ~90% of tokens, because the standard
 * launchpad deploys EIP-1167 minimal proxies — and a minimal proxy contains
 * exactly one DELEGATECALL, which is the proxy mechanism itself.
 *
 * That check was backwards. An EIP-1167 clone is 45 bytes with the
 * implementation address HARDCODED in immutable bytecode. There is no admin
 * slot and no way to repoint it. It is one of the most immutable shapes a token
 * can have, and the old check penalised it for being safe.
 *
 * ## Why `owner()` alone means nothing
 *
 * The same launchpad's implementation exposes `owner()` as a plain attribution
 * getter. Its full function set is name/symbol/decimals/totalSupply/balanceOf/
 * transfer/transferFrom/approve/allowance/owner/logo — no mint, no pause, no
 * blacklist, not even transferOwnership. The owner cannot do anything at all,
 * so "ownership not renounced" was a 250-point penalty for a getter.
 *
 * So authority is judged by CAPABILITY, not by shape: does a function exist
 * that could change the token's behaviour after purchase?
 */
library Authority {
    /// EIP-1167 minimal proxy: 45 bytes, implementation at offset 10.
    uint256 internal constant MINIMAL_PROXY_SIZE = 45;

    struct Report {
        /// True when the contract is genuinely replaceable.
        bool upgradeable;
        /// True when the bytecode is an EIP-1167 clone (immutable by construction).
        bool minimalProxy;
        /// The implementation a clone points at, or the token itself.
        address implementation;
        /// True when `owner()` exists and is non-zero.
        bool ownerRetained;
        /// True when a privileged function exists that could change behaviour.
        bool ownerHasPowers;
    }

    function inspect(address token) internal view returns (Report memory r) {
        r.implementation = token;

        bytes memory code = _codeAt(token);
        if (code.length == 0) return r;

        address impl = _minimalProxyTarget(code);
        if (impl != address(0)) {
            // A clone. Immutable by construction — the target is in the code,
            // not in storage, so nobody can repoint it.
            r.minimalProxy = true;
            r.implementation = impl;
            r.upgradeable = false;
            code = _codeAt(impl);
        } else {
            // Not a clone. DELEGATECALL now genuinely suggests a mutable
            // implementation pointer, since there is no fixed target in code.
            r.upgradeable = _containsDelegatecall(code);
        }

        (bool hasOwner, address owner) = _owner(token);
        r.ownerRetained = hasOwner && owner != address(0);
        r.ownerHasPowers = r.ownerRetained && _hasPrivilegedFunction(code);
    }

    /**
     * Recognise `363d3d373d3d3d363d73<impl>5af43d82803e903d91602b57fd5bf3`.
     * Returns the implementation, or address(0) if this is not a clone.
     */
    function _minimalProxyTarget(bytes memory code) private pure returns (address) {
        if (code.length != MINIMAL_PROXY_SIZE) return address(0);

        // Prefix: 36 3d 3d 37 3d 3d 3d 36 3d 73
        bytes10 prefix = 0x363d3d373d3d3d363d73;
        for (uint256 i; i < 10; ++i) {
            if (code[i] != prefix[i]) return address(0);
        }

        uint160 impl;
        for (uint256 i = 10; i < 30; ++i) {
            impl = (impl << 8) | uint160(uint8(code[i]));
        }
        return address(impl);
    }

    /**
     * Does the bytecode dispatch any function that could change how the token
     * behaves after purchase?
     *
     * Selectors appear in a dispatcher as PUSH4 operands, so the scan looks for
     * the 4-byte sequences directly. This over-reports slightly — a selector
     * could coincidentally appear inside other PUSH data — and that direction is
     * the safe one. It does not under-report.
     */
    function _hasPrivilegedFunction(bytes memory code) private pure returns (bool) {
        bytes4[13] memory dangerous = [
            bytes4(0x40c10f19), // mint(address,uint256)
            bytes4(0xa0712d68), // mint(uint256)
            bytes4(0x9dc29fac), // burn(address,uint256)
            bytes4(0x79cc6790), // burnFrom(address,uint256)
            bytes4(0x8456cb59), // pause()
            bytes4(0xf9f92be4), // blacklist(address)
            bytes4(0x153b0d1e), // setBlacklist(address,bool)
            bytes4(0xf2fde38b), // transferOwnership(address)
            bytes4(0x69fe0e2d), // setFee(uint256)
            bytes4(0x667f6526), // setTax(uint256,uint256)
            bytes4(0x0b78f9c0), // setFees(uint256,uint256)
            bytes4(0x5d0044ca), // setMaxWallet(uint256)
            bytes4(0x8a8c523c) //  enableTrading()
        ];

        if (code.length < 4) return false;
        for (uint256 i; i <= code.length - 4; ++i) {
            bytes4 word =
                bytes4(code[i]) | (bytes4(code[i + 1]) >> 8) | (bytes4(code[i + 2]) >> 16)
                    | (bytes4(code[i + 3]) >> 24);
            for (uint256 j; j < dangerous.length; ++j) {
                if (word == dangerous[j]) return true;
            }
        }
        return false;
    }

    function _containsDelegatecall(bytes memory code) private pure returns (bool) {
        for (uint256 i; i < code.length; ++i) {
            if (code[i] == 0xf4) return true;
        }
        return false;
    }

    function _owner(address token) private view returns (bool has, address owner) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || data.length < 32) return (false, address(0));
        return (true, abi.decode(data, (address)));
    }

    function _codeAt(address a) private view returns (bytes memory code) {
        uint256 size;
        assembly {
            size := extcodesize(a)
        }
        code = new bytes(size);
        if (size == 0) return code;
        assembly {
            extcodecopy(a, add(code, 0x20), 0, size)
        }
    }
}
