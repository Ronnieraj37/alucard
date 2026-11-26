// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice What differs between the testnets the scripts deploy to: the deployment file prefix and Chainlink's feeds.
/// Every feed answers in USD with 8 decimals. A zero feed has no Chainlink feed on that chain and gets a fixed $1 mock
/// (stablecoins only). Addresses: Chainlink's published lists (reference-data-directory, feeds-<network>.json).
library Net {
    struct Feeds {
        address eth;
        address btc;
        address link;
        address usdc;
        address usdt; // 0: $1 mock
        address dai; // 0: $1 mock
        uint32 hourlyAge; // how old a volatile feed's answer may be (heartbeat plus slack)
        uint32 dailyAge; // the same for stablecoin feeds
    }

    uint256 constant SEPOLIA = 11155111;
    uint256 constant UNICHAIN_SEPOLIA = 1301;

    /// @notice The prefix of this chain's files in deployments/ ("sepolia-core.json", "unichain-sepolia-core.json").
    function name(uint256 chainId) internal pure returns (string memory) {
        if (chainId == UNICHAIN_SEPOLIA) return "unichain-sepolia";
        if (chainId == SEPOLIA) return "sepolia";
        revert("unsupported chain");
    }

    function feeds(uint256 chainId) internal pure returns (Feeds memory) {
        if (chainId == UNICHAIN_SEPOLIA) {
            // every feed here has a 24 h heartbeat
            return Feeds({
                eth: 0xd9c93081210dFc33326B2af4C2c11848095E6a9a,
                btc: 0x2AF69319fACBbc1ad77d56538B35c1f9FFe86dEF,
                link: 0x331b7521a8985dbDdA5CF4FCDB57EC25465C55cB,
                usdc: 0x25DdD2fEd0d51fe79d292Da47dd9f10AbdB4b3EC,
                usdt: 0xd391fB4c7D0B88dc44530E785246112388AFA98F,
                dai: address(0),
                hourlyAge: 26 hours,
                dailyAge: 26 hours
            });
        }
        if (chainId == SEPOLIA) {
            return Feeds({
                eth: 0x694AA1769357215DE4FAC081bf1f309aDC325306,
                btc: 0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43,
                link: 0xc59E3633BAAC79493d908e63626716e204A45EdF,
                usdc: 0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E,
                usdt: address(0),
                dai: 0x14866185B1962B63C3Ea9E03Bc1da838bab34C19,
                hourlyAge: 3 hours,
                dailyAge: 26 hours
            });
        }
        revert("unsupported chain");
    }

    function file(uint256 chainId, string memory dir, string memory what) internal pure returns (string memory) {
        return string.concat(dir, "/", name(chainId), "-", what, ".json");
    }
}
