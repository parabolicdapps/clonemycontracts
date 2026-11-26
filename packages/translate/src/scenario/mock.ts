export const MOCK_ERC20_NAME = 'CmcMockToken';
export const MOCK_ERC20_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract CmcMockToken {
    string public name = "Mock"; string public symbol = "MCK"; uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(uint8 d) { decimals = d; }
    function mint(address to, uint256 a) external { totalSupply += a; balanceOf[to] += a; emit Transfer(address(0), to, a); }
    function transfer(address to, uint256 a) external returns (bool) { _t(msg.sender, to, a); return true; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; emit Approval(msg.sender, s, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) { require(al >= a, "allowance"); allowance[f][msg.sender] = al - a; }
        _t(f, to, a); return true;
    }
    function _t(address f, address to, uint256 a) internal { require(balanceOf[f] >= a, "balance"); balanceOf[f] -= a; balanceOf[to] += a; emit Transfer(f, to, a); }
}
`;

/** Minimal EIP-1967 style proxy used to run an IMPLEMENTATION the way it runs behind its real proxy: the initialiser executes through delegatecall with the deployer as msg.sender. */
export const PROXY_NAME = 'CmcProxy';
export const PROXY_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract CmcProxy {
    bytes32 constant SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    constructor(address impl, bytes memory data) payable {
        assembly { sstore(SLOT, impl) }
        if (data.length > 0) {
            (bool ok, bytes memory ret) = impl.delegatecall(data);
            if (!ok) { assembly { revert(add(ret, 32), mload(ret)) } }
        }
    }
    fallback() external payable {
        assembly {
            let impl := sload(SLOT)
            calldatacopy(0, 0, calldatasize())
            let r := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch r case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }
        }
    }
    receive() external payable {}
}
`;
