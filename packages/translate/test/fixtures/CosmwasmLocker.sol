// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Locks an ERC-20 until `unlockAt`; also collects native tips that the admin can sweep. (Worked example of the CosmWasm pack.)
contract CosmwasmLocker {
    IERC20Min public immutable token;
    address public admin;
    uint256 public unlockAt;
    uint256 public total;
    mapping(address => uint256) public deposits;
    mapping(address => uint256) public tips;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    constructor(IERC20Min _token, uint256 _unlockAt) {
        token = _token;
        admin = msg.sender;
        unlockAt = _unlockAt;
    }

    function deposit(uint256 amount) external {
        require(amount > 0, "zero amount");
        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");
        deposits[msg.sender] += amount;
        total += amount;
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        require(block.timestamp >= unlockAt, "still locked");
        require(amount > 0, "zero amount");
        require(deposits[msg.sender] >= amount, "insufficient deposit");
        deposits[msg.sender] -= amount;
        total -= amount;
        require(token.transfer(msg.sender, amount), "transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    function setUnlock(uint256 t) external {
        require(msg.sender == admin, "not admin");
        unlockAt = t;
    }

    function unlocked() public view returns (bool) {
        return block.timestamp >= unlockAt;
    }

    function tip() external payable {
        require(msg.value > 0, "no tip");
        tips[msg.sender] += msg.value;
    }

    function sweep(address to) external {
        require(msg.sender == admin, "not admin");
        uint256 bal = address(this).balance;
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "sweep failed");
    }
}
