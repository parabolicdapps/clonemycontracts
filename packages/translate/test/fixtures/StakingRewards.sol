// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

/// Stake one token, earn another at a fixed rate per second shared pro rata (reward-per-token accounting).
contract StakingRewards {
    IERC20Min public immutable stakingToken;
    IERC20Min public immutable rewardToken;
    address public owner;

    uint256 public rewardRate; // reward tokens per second
    uint256 public periodFinish;
    uint256 public lastUpdate;
    uint256 public rewardPerTokenStored;
    uint256 public totalStaked;

    mapping(address => uint256) public staked;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event RewardsStarted(uint256 amount, uint256 duration);

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdate = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    constructor(IERC20Min _staking, IERC20Min _reward) {
        stakingToken = _staking;
        rewardToken = _reward;
        owner = msg.sender;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdate) * rewardRate * 1e18) / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return (staked[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18 + rewards[account];
    }

    function stake(uint256 amount) external updateReward(msg.sender) {
        require(amount > 0, "zero amount");
        totalStaked += amount;
        staked[msg.sender] += amount;
        require(stakingToken.transferFrom(msg.sender, address(this), amount), "transfer failed");
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public updateReward(msg.sender) {
        require(amount > 0, "zero amount");
        require(staked[msg.sender] >= amount, "insufficient stake");
        totalStaked -= amount;
        staked[msg.sender] -= amount;
        require(stakingToken.transfer(msg.sender, amount), "transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            require(rewardToken.transfer(msg.sender, reward), "transfer failed");
            emit RewardPaid(msg.sender, reward);
        }
    }

    function exit() external {
        withdraw(staked[msg.sender]);
        getReward();
    }

    /// Owner funds a new reward period; leftover from the previous period rolls in.
    function startRewards(uint256 amount, uint256 duration) external updateReward(address(0)) {
        require(msg.sender == owner, "not owner");
        require(duration > 0, "zero duration");
        require(rewardToken.transferFrom(msg.sender, address(this), amount), "transfer failed");
        if (block.timestamp >= periodFinish) {
            rewardRate = amount / duration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (amount + leftover) / duration;
        }
        lastUpdate = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardsStarted(amount, duration);
    }
}
